import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, createUser, loginAs, type TestContext } from './app.js';
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

describe('take next', () => {
  it('six simultaneous requests get six different tickets', async () => {
    const agents = await Promise.all(
      Array.from({ length: 6 }, () => createUser(ctx.db, 'agent', ['billing'])),
    );
    const sessions = await Promise.all(agents.map((a) => loginAs(ctx, a)));
    for (let i = 0; i < 8; i++) await createTicket(w.as.customer, { category: 'billing' });

    // supertest agents each open their own HTTP connection; the api uses separate pool clients
    const results = await Promise.all(sessions.map((s) => s.post('/tickets/take-next')));
    expect(results.map((r) => r.status)).toEqual(Array(6).fill(200));
    const ids = results.map((r) => r.body.id as string);
    expect(new Set(ids).size).toBe(6);
    results.forEach((r, i) => {
      expect(r.body.assignee.id).toBe(agents[i]!.id);
    });
    const assigned = await ctx.pool.query(
      'select count(*)::int as n from tickets where assignee_id is not null',
    );
    expect(assigned.rows[0].n).toBe(6);
  });

  it('picks the most urgent ticket of the caller categories', async () => {
    const low = await createTicket(w.as.customer, { category: 'billing', priority: 'low' });
    ctx.clock.advance(60_000);
    const high = await createTicket(w.as.customer, { category: 'billing', priority: 'high' });
    await createTicket(w.as.customer, { category: 'technical', priority: 'high' });
    const first = await w.as.billingAgent.post('/tickets/take-next');
    expect(first.body.id).toBe(high.id);
    const second = await w.as.billingAgent.post('/tickets/take-next');
    expect(second.body.id).toBe(low.id);
    const none = await w.as.billingAgent.post('/tickets/take-next');
    expect(none.status).toBe(404);
    expect(none.body.error.code).toBe('no_tickets_available');
    expect((await w.as.customer.post('/tickets/take-next')).status).toBe(403);
  });
});

describe('bulk', () => {
  it('applies to 200 tickets and reports skipped ones with reasons', async () => {
    const billing: string[] = [];
    for (let i = 0; i < 150; i++) {
      billing.push((await createTicket(w.as.customer, { category: 'billing' })).id);
    }
    const tech: string[] = [];
    for (let i = 0; i < 40; i++) {
      tech.push((await createTicket(w.as.customer, { category: 'technical' })).id);
    }
    // 5 billing tickets are closed -> cannot change; 10 ids do not exist
    const closed = billing.slice(0, 5);
    await ctx.pool.query(`update tickets set status = 'closed' where id = any($1::uuid[])`, [
      closed,
    ]);
    const missing = Array.from({ length: 10 }, () => randomUUID());
    const ids = [...billing, ...tech, ...missing];
    expect(ids).toHaveLength(200);

    const res = await w.as.billingAgent
      .post('/tickets/bulk')
      .send({ ids, action: { type: 'priority', priority: 'high' } });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(200);
    expect(res.body.succeeded).toBe(145);
    expect(res.body.skipped).toBe(55);

    const reasons = new Map<string, string>(
      (res.body.results as { id: string; ok: boolean; reason?: string }[])
        .filter((r) => !r.ok)
        .map((r) => [r.id, r.reason!]),
    );
    for (const id of closed) expect(reasons.get(id)).toBe('ticket_closed');
    for (const id of tech) expect(reasons.get(id)).toBe('forbidden');
    for (const id of missing) expect(reasons.get(id)).toBe('not_found');
    // results keep the request order
    expect((res.body.results as { id: string }[]).map((r) => r.id)).toEqual(ids);

    const high = await ctx.pool.query(
      `select count(*)::int as n from tickets where priority = 'high'`,
    );
    expect(high.rows[0].n).toBe(145);
    const events = await ctx.pool.query(
      `select count(*)::int as n from ticket_events where field = 'priority'`,
    );
    expect(events.rows[0].n).toBe(145);
  });

  it('reports invalid transitions and assignments per ticket', async () => {
    const a = await createTicket(w.as.customer);
    const b = await createTicket(w.as.customer);
    await ctx.pool.query(`update tickets set status = 'pending' where id = $1`, [b.id]);
    const res = await w.as.lead
      .post('/tickets/bulk')
      .send({ ids: [a.id, b.id], action: { type: 'status', status: 'open' } });
    expect(res.body.results).toEqual([
      { id: a.id, ok: true },
      { id: b.id, ok: true },
    ]);
    const toNew = await w.as.lead
      .post('/tickets/bulk')
      .send({ ids: [a.id], action: { type: 'status', status: 'new' } });
    expect(toNew.body.results).toEqual([{ id: a.id, ok: false, reason: 'invalid_transition' }]);
    const badAssignee = await w.as.lead
      .post('/tickets/bulk')
      .send({ ids: [a.id], action: { type: 'assign', assigneeId: w.customer.id } });
    expect(badAssignee.body.results[0].reason).toBe('invalid_assignee');
    const agentAssignsOther = await w.as.billingAgent
      .post('/tickets/bulk')
      .send({ ids: [a.id], action: { type: 'assign', assigneeId: w.techAgent.id } });
    expect(agentAssignsOther.body.results[0].reason).toBe('forbidden');
  });

  it('adds and removes tags', async () => {
    const t = await createTicket(w.as.customer);
    await w.as.lead.patch(`/tickets/${t.id}`).send({ version: 0, tags: ['a', 'b'] });
    const res = await w.as.lead
      .post('/tickets/bulk')
      .send({ ids: [t.id], action: { type: 'tags', add: ['c'], remove: ['a'] } });
    expect(res.body.succeeded).toBe(1);
    const detail = await w.as.lead.get(`/tickets/${t.id}`);
    expect(detail.body.ticket.tags).toEqual(['b', 'c']);
  });

  it('validates the request', async () => {
    const tooMany = Array.from({ length: 201 }, () => randomUUID());
    expect(
      (
        await w.as.lead
          .post('/tickets/bulk')
          .send({ ids: tooMany, action: { type: 'priority', priority: 'low' } })
      ).status,
    ).toBe(400);
    expect(
      (await w.as.lead.post('/tickets/bulk').send({ ids: [], action: { type: 'x' } })).status,
    ).toBe(400);
    expect(
      (
        await w.as.customer
          .post('/tickets/bulk')
          .send({ ids: [randomUUID()], action: { type: 'priority', priority: 'low' } })
      ).status,
    ).toBe(403);
  });
});
