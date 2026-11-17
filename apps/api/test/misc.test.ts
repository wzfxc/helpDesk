import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from './app.js';
import { resetDb } from './db.js';
import { createTicket, createWorld, type World } from './fixtures.js';

let ctx: TestContext;
let w: World;
beforeAll(async () => {
  ctx = await createTestApp();
});
beforeEach(async () => {
  await resetDb(ctx.pool);
  ctx.clock.set('2025-01-07T08:00:00.000Z');
  w = await createWorld(ctx);
});
afterAll(async () => {
  await ctx.close();
});

describe('notifications', () => {
  it('lists and marks read', async () => {
    const t = await createTicket(w.as.customer);
    await w.as.lead.patch(`/tickets/${t.id}`).send({ version: 0, assigneeId: w.billingAgent.id });
    const list = await w.as.billingAgent.get('/notifications');
    expect(list.body.unreadCount).toBe(1);
    expect(list.body.items[0]).toMatchObject({ kind: 'ticket_assigned', ticketId: t.id });
    const read = await w.as.billingAgent
      .post('/notifications/read')
      .send({ ids: [list.body.items[0].id] });
    expect(read.body.unreadCount).toBe(0);
    expect((await w.as.techAgent.get('/notifications')).body.items).toEqual([]);
    expect((await w.as.billingAgent.post('/notifications/read').send({})).status).toBe(400);
  });
});

describe('canned responses, views, sla policies, stats', () => {
  it('canned CRUD is lead-only for writes', async () => {
    const body = { title: 'Hi', body: 'Hello {{customerName}}', category: null };
    expect((await w.as.billingAgent.post('/canned-responses').send(body)).status).toBe(403);
    const created = await w.as.lead.post('/canned-responses').send(body);
    expect(created.status).toBe(201);
    expect((await w.as.billingAgent.get('/canned-responses')).body).toHaveLength(1);
    expect((await w.as.customer.get('/canned-responses')).status).toBe(403);
    const upd = await w.as.lead
      .put(`/canned-responses/${created.body.id}`)
      .send({ ...body, title: 'Hi2' });
    expect(upd.body.title).toBe('Hi2');
    expect((await w.as.lead.delete(`/canned-responses/${created.body.id}`)).status).toBe(204);
    expect((await w.as.lead.delete(`/canned-responses/${randomUUID()}`)).status).toBe(404);
  });

  it('saved views: built-ins plus own', async () => {
    const v = await w.as.billingAgent
      .post('/views')
      .send({ name: 'Mine', query: 'status=open&assignee=me' });
    expect(v.status).toBe(201);
    expect(
      (await w.as.billingAgent.post('/views').send({ name: 'x', query: 'status=zzz' })).status,
    ).toBe(400);
    const list = await w.as.billingAgent.get('/views');
    expect(list.body.filter((x: { builtIn: boolean }) => x.builtIn)).toHaveLength(3);
    expect(list.body.some((x: { id: string }) => x.id === v.body.id)).toBe(true);
    expect(
      (await w.as.techAgent.get('/views')).body.some((x: { id: string }) => x.id === v.body.id),
    ).toBe(false);
    expect((await w.as.techAgent.delete(`/views/${v.body.id}`)).status).toBe(404);
  });

  it('SLA policies are editable by lead only and apply to new tickets', async () => {
    const policies = (await w.as.lead.get('/sla-policies')).body as {
      priority: string;
      firstResponseMinutes: number;
      resolutionMinutes: number;
    }[];
    const next = policies.map((p) =>
      p.priority === 'low' ? { ...p, firstResponseMinutes: 60, resolutionMinutes: 120 } : p,
    );
    expect((await w.as.billingAgent.put('/sla-policies').send({ policies: next })).status).toBe(
      403,
    );
    expect((await w.as.lead.put('/sla-policies').send({ policies: next })).status).toBe(200);
    const t = await createTicket(w.as.customer, { priority: 'low' });
    expect(t.firstResponseDueAt).toBe('2025-01-07T09:00:00.000Z');
  });

  it('stats for lead', async () => {
    const t = await createTicket(w.as.customer);
    await w.as.billingAgent
      .post(`/tickets/${t.id}/messages`)
      .send({ clientMessageId: randomUUID(), body: 'hi' });
    const q = `from=${encodeURIComponent('2025-01-01T00:00:00Z')}&to=${encodeURIComponent('2025-02-01T00:00:00Z')}`;
    const res = await w.as.lead.get(`/stats?${q}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 1, resolved: 0, avgFirstResponseMinutes: 0 });
    expect((await w.as.billingAgent.get(`/stats?${q}`)).status).toBe(403);
    expect((await w.as.lead.get('/stats?from=x&to=y')).status).toBe(400);
  });
});
