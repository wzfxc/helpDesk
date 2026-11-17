import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS, type ServerEvent } from '@helpdesk/shared';
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
  ids: string[];
  raw: () => string;
  close: () => void;
  status: number;
}

async function openStream(cookie?: string, lastEventId?: string): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const events: ServerEvent[] = [];
    const ids: string[] = [];
    let raw = '';
    const headers: Record<string, string> = {};
    if (cookie) headers.Cookie = cookie;
    if (lastEventId !== undefined) headers['Last-Event-ID'] = lastEventId;
    const req = http.get({ port, path: '/events', headers }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        raw += chunk;
        for (const m of chunk.matchAll(/^id: (.*)$/gm)) {
          ids.push(m[1]!);
        }
        for (const m of chunk.matchAll(/^data: (.*)$/gm)) {
          events.push(JSON.parse(m[1]!) as ServerEvent);
        }
      });
      const status = res.statusCode ?? 0;
      // wait for the ': connected' preamble
      const t = setInterval(() => {
        if (status !== 200 || raw.includes(': connected')) {
          clearInterval(t);
          resolve({ events, ids, raw: () => raw, close: () => req.destroy(), status });
        }
      }, 10);
    });
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

  it('replays missed events after Last-Event-ID while keeping internal notes hidden', async () => {
    const t = await createTicket(w.as.customer);
    const customerCookie = await cookieFor(w.customer);
    const staffCookie = await cookieFor(w.billingAgent);

    // Establish initial stream and capture the last event ID seen before disconnecting.
    const initial = await openStream(customerCookie);
    await w.as.billingAgent
      .post(`/tickets/${t.id}/messages`)
      .send({ clientMessageId: randomUUID(), body: 'before disconnect' });
    await until(() => initial.events.some((e) => e.type === 'message.created'));
    const lastSeenId = initial.ids.at(-1);
    expect(lastSeenId).toMatch(/^\d+$/);
    initial.close();
    await wait(50);

    // Emit an internal note and a public reply while disconnected (plus typing, which should not replay).
    await w.as.billingAgent
      .post(`/tickets/${t.id}/messages`)
      .send({ clientMessageId: randomUUID(), body: 'hidden replay note', internal: true });
    await w.as.billingAgent
      .post(`/tickets/${t.id}/messages`)
      .send({ clientMessageId: randomUUID(), body: 'missed public reply' });
    await w.as.billingAgent.post(`/tickets/${t.id}/typing`);
    await wait(150);

    // Customer reconnects with Last-Event-ID -> only missed public reply (and updates), never old events or internal note.
    const reconnectedCustomer = await openStream(customerCookie, lastSeenId);
    await until(() =>
      reconnectedCustomer.events.some(
        (e) => e.type === 'message.created' && e.message.body === 'missed public reply',
      ),
    );
    await wait(200);
    const customerBodies = reconnectedCustomer.events
      .filter((e) => e.type === 'message.created')
      .map((e) => e.message.body);
    expect(customerBodies).toEqual(['missed public reply']);
    expect(reconnectedCustomer.raw()).not.toContain('hidden replay note');
    expect(reconnectedCustomer.raw()).not.toContain('before disconnect');
    expect(reconnectedCustomer.events.some((e) => e.type === 'typing')).toBe(false);
    expect(reconnectedCustomer.ids.every((id) => Number(id) > Number(lastSeenId))).toBe(true);

    // Staff reconnecting from the same Last-Event-ID receives both the internal note and the public reply.
    const reconnectedStaff = await openStream(staffCookie, lastSeenId);
    await until(
      () => reconnectedStaff.events.filter((e) => e.type === 'message.created').length >= 2,
    );
    const staffBodies = reconnectedStaff.events
      .filter((e) => e.type === 'message.created')
      .map((e) => e.message.body);
    expect(staffBodies).toEqual(['hidden replay note', 'missed public reply']);

    // Invalid Last-Event-ID is safely ignored.
    const invalid = await openStream(customerCookie, 'not-a-number');
    expect(invalid.status).toBe(200);

    reconnectedCustomer.close();
    reconnectedStaff.close();
    invalid.close();
  });
});

describe('SSE connection cap', () => {
  it('allows LIMITS.sseMaxPerUser streams per user, answers 429 beyond and frees slots on close', async () => {
    const cookie = await cookieFor(w.customer);
    const open: Stream[] = [];
    for (let i = 0; i < LIMITS.sseMaxPerUser; i++) open.push(await openStream(cookie));
    expect(open.every((s) => s.status === 200)).toBe(true);

    const over = await openStream(cookie);
    expect(over.status).toBe(429);
    expect(over.raw()).toContain('rate_limited');

    // other users are not affected
    const other = await openStream(await cookieFor(w.customer2));
    expect(other.status).toBe(200);

    open[0]!.close();
    await wait(200);
    const again = await openStream(cookie);
    expect(again.status).toBe(200);
    [...open, other, again].forEach((s) => {
      s.close();
    });
  });
});
