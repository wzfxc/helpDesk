import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ServerEvent } from '@helpdesk/shared';
import { createTestApp, PASSWORD, type TestContext, type TestUser } from './app.js';
import { resetDb } from './db.js';
import { createTicket, createWorld, type World } from './fixtures.js';

let ctx: TestContext;
let w: World;
let port: number;

beforeAll(async () => {
  ctx = await createTestApp();
  await ctx.app.listen(0);
  port = (ctx.app.getHttpServer().address() as AddressInfo).port;
});
beforeEach(async () => {
  await resetDb(ctx.pool);
  w = await createWorld(ctx);
});
afterAll(async () => {
  await ctx.close();
});

async function cookieFor(user: TestUser): Promise<string> {
  const res = await ctx.http.post('/auth/login').send({ email: user.email, password: PASSWORD });
  return String(res.headers['set-cookie']).split(';')[0]!;
}

interface Stream {
  events: ServerEvent[];
  raw: () => string;
  close: () => void;
  status: number;
}

async function openStream(cookie?: string): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const events: ServerEvent[] = [];
    let raw = '';
    const req = http.get(
      { port, path: '/events', headers: cookie ? { Cookie: cookie } : {} },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          raw += chunk;
          for (const m of chunk.matchAll(/^data: (.*)$/gm)) {
            events.push(JSON.parse(m[1]!) as ServerEvent);
          }
        });
        const status = res.statusCode ?? 0;
        // wait for the ': connected' preamble
        const t = setInterval(() => {
          if (status !== 200 || raw.includes(': connected')) {
            clearInterval(t);
            resolve({ events, raw: () => raw, close: () => req.destroy(), status });
          }
        }, 10);
      },
    );
    req.on('error', (e) => {
      if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e);
    });
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!fn() && Date.now() - start < ms) await wait(25);
}

describe('GET /events', () => {
  it('requires a session', async () => {
    const s = await openStream();
    expect(s.status).toBe(401);
    s.close();
  });

  it('delivers public replies to the customer live, never internal notes', async () => {
    const t = await createTicket(w.as.customer);
    const customer = await openStream(await cookieFor(w.customer));
    const other = await openStream(await cookieFor(w.customer2));
    const staff = await openStream(await cookieFor(w.billingAgent));
    const tech = await openStream(await cookieFor(w.techAgent));

    await w.as.billingAgent
      .post(`/tickets/${t.id}/messages`)
      .send({ clientMessageId: randomUUID(), body: 'secret internal note', internal: true });
    await w.as.billingAgent
      .post(`/tickets/${t.id}/messages`)
      .send({ clientMessageId: randomUUID(), body: 'public answer' });

    await until(() => customer.events.some((e) => e.type === 'message.created'));
    await until(() => staff.events.filter((e) => e.type === 'message.created').length >= 2);
    await wait(300);

    const customerMessages = customer.events.filter((e) => e.type === 'message.created');
    expect(customerMessages).toHaveLength(1);
    expect(JSON.stringify(customer.events)).not.toContain('secret internal note');
    expect(customer.raw()).not.toContain('secret internal note');
    expect(customer.events.some((e) => e.type === 'ticket.updated')).toBe(true);

    expect(staff.events.filter((e) => e.type === 'message.created')).toHaveLength(2);
    // other customers and agents of other categories receive nothing about this ticket
    expect(other.events).toEqual([]);
    expect(tech.events).toEqual([]);
    [customer, other, staff, tech].forEach((s) => {
      s.close();
    });
  });

  it('streams new tickets to matching agents and assignment notifications to the assignee', async () => {
    const billing = await openStream(await cookieFor(w.billingAgent));
    const tech = await openStream(await cookieFor(w.techAgent));
    const t = await createTicket(w.as.customer, { category: 'billing' });
    await until(() => billing.events.some((e) => e.type === 'ticket.created'));
    expect(billing.events.some((e) => e.type === 'ticket.created')).toBe(true);
    await wait(200);
    expect(tech.events).toEqual([]);

    await w.as.lead.patch(`/tickets/${t.id}`).send({ version: 0, assigneeId: w.billingAgent.id });
    await until(() => billing.events.some((e) => e.type === 'notification.created'));
    expect(billing.events.find((e) => e.type === 'notification.created')).toMatchObject({
      notification: { kind: 'ticket_assigned', ticketId: t.id },
    });
    expect(tech.events.some((e) => e.type === 'notification.created')).toBe(false);
    billing.close();
    tech.close();
  });

  it('typing is delivered to other staff only', async () => {
    const t = await createTicket(w.as.customer);
    const customer = await openStream(await cookieFor(w.customer));
    const lead = await openStream(await cookieFor(w.lead));
    const self = await openStream(await cookieFor(w.billingAgent));
    expect((await w.as.billingAgent.post(`/tickets/${t.id}/typing`)).status).toBe(204);
    await until(() => lead.events.some((e) => e.type === 'typing'));
    expect(lead.events.find((e) => e.type === 'typing')).toMatchObject({
      ticketId: t.id,
      user: { id: w.billingAgent.id, name: w.billingAgent.name },
    });
    await wait(200);
    expect(customer.events.some((e) => e.type === 'typing')).toBe(false);
    expect(self.events.some((e) => e.type === 'typing')).toBe(false);
    expect((await w.as.customer.post(`/tickets/${t.id}/typing`)).status).toBe(403);
    expect((await w.as.techAgent.post(`/tickets/${t.id}/typing`)).status).toBe(404);
    [customer, lead, self].forEach((s) => {
      s.close();
    });
  });
});
