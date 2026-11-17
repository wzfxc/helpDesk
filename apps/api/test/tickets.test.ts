import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, createUser, loginAs, type TestContext } from './app.js';
import { resetDb } from './db.js';
import { createTicket, createWorld, type World } from './fixtures.js';

let ctx: TestContext;
let w: World;

// Friday 2025-01-10 17:00 Kyiv (UTC+2)
const FRI_17 = '2025-01-10T15:00:00.000Z';

beforeAll(async () => {
  ctx = await createTestApp();
});
beforeEach(async () => {
  await resetDb(ctx.pool);
  ctx.clock.set(FRI_17);
  w = await createWorld(ctx);
});
afterAll(async () => {
  await ctx.close();
});

describe('create', () => {
  it('creates a ticket with number, SLA deadlines and the first message', async () => {
    const t = await createTicket(w.as.customer, { priority: 'high' });
    expect(t.number).toBe(1001);
    expect(t.status).toBe('new');
    // Acceptance #10: high on Friday 17:00 -> Mon 12:00 / Mon 17:00 Kyiv
    expect(t.firstResponseDueAt).toBe('2025-01-13T10:00:00.000Z');
    expect(t.resolutionDueAt).toBe('2025-01-13T15:00:00.000Z');
    const detail = await w.as.customer.get(`/tickets/${t.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.messages).toHaveLength(1);
    expect(detail.body.messages[0].body).toBe('My card was charged twice');
    expect(detail.body.events).toEqual([]);
  });

  it('customers cannot pick urgent; staff cannot create', async () => {
    const urgent = await w.as.customer
      .post('/tickets')
      .send({ subject: 's', category: 'billing', priority: 'urgent', body: 'b' });
    expect(urgent.status).toBe(400);
    expect(urgent.body.error.details[0].path).toBe('priority');
    const staff = await w.as.billingAgent
      .post('/tickets')
      .send({ subject: 's', category: 'billing', priority: 'low', body: 'b' });
    expect(staff.status).toBe(403);
  });

  it('50 concurrent creations get consecutive numbers without gaps or duplicates', async () => {
    const customers = await Promise.all(
      Array.from({ length: 5 }, () => createUser(ctx.db, 'customer')),
    );
    const agents = await Promise.all(customers.map((c) => loginAs(ctx, c)));
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        agents[i % agents.length]!.post('/tickets').send({
          subject: `Parallel ${i}`,
          category: 'other',
          priority: 'low',
          body: 'x',
        }),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const numbers = results.map((r) => r.body.number as number).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(50);
    expect(numbers[0]).toBe(1001);
    expect(numbers[49]).toBe(1050);
    const counter = await ctx.pool.query<{ value: number }>('select value from ticket_counter');
    expect(counter.rows[0]?.value).toBe(1050);
  });

  it('a rolled back creation does not consume a number', async () => {
    const bad = await w.as.customer.post('/tickets').send({
      subject: 's',
      category: 'billing',
      priority: 'low',
      body: 'b',
      attachmentIds: ['3f1c2b7e-8a4d-4c1e-9b2f-1a2b3c4d5e6f'],
    });
    expect(bad.status).toBe(422);
    const t = await createTicket(w.as.customer);
    expect(t.number).toBe(1001);
  });
});

describe('permissions', () => {
  it('customer cannot see another customer ticket (404)', async () => {
    const t = await createTicket(w.as.customer);
    expect((await w.as.customer2.get(`/tickets/${t.id}`)).status).toBe(404);
    expect((await w.as.customer.get(`/tickets/${t.id}`)).status).toBe(200);
  });

  it('agent of another category gets 404 unless the ticket is assigned to them', async () => {
    const t = await createTicket(w.as.customer, { category: 'billing' });
    expect((await w.as.techAgent.get(`/tickets/${t.id}`)).status).toBe(404);
    expect((await w.as.billingAgent.get(`/tickets/${t.id}`)).status).toBe(200);
    expect((await w.as.lead.get(`/tickets/${t.id}`)).status).toBe(200);

    const assign = await w.as.lead
      .patch(`/tickets/${t.id}`)
      .send({ version: t.version, assigneeId: w.techAgent.id });
    expect(assign.status).toBe(200);
    expect((await w.as.techAgent.get(`/tickets/${t.id}`)).status).toBe(200);
  });

  it('agent of another category cannot patch (404)', async () => {
    const t = await createTicket(w.as.customer, { category: 'billing' });
    const res = await w.as.techAgent.patch(`/tickets/${t.id}`).send({ version: 0, status: 'open' });
    expect(res.status).toBe(404);
  });

  it('customers cannot patch tickets', async () => {
    const t = await createTicket(w.as.customer);
    const res = await w.as.customer.patch(`/tickets/${t.id}`).send({ version: 0, status: 'open' });
    expect(res.status).toBe(403);
  });

  it('rejects malformed ids with 400', async () => {
    const res = await w.as.lead.get('/tickets/not-a-uuid');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('requires a session', async () => {
    const t = await createTicket(w.as.customer);
    expect((await request(ctx.app.getHttpServer()).get(`/tickets/${t.id}`)).status).toBe(401);
  });
});

describe('update', () => {
  it('changes fields, writes history and bumps the version', async () => {
    const t = await createTicket(w.as.customer);
    const res = await w.as.billingAgent.patch(`/tickets/${t.id}`).send({
      version: t.version,
      status: 'open',
      priority: 'high',
      tags: ['VIP', 'refund'],
      assigneeId: w.billingAgent.id,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'open',
      priority: 'high',
      tags: ['vip', 'refund'],
      version: t.version + 1,
      assignee: { id: w.billingAgent.id },
    });
    const detail = await w.as.lead.get(`/tickets/${t.id}`);
    const fields = (detail.body.events as { field: string; actor: { id: string } }[])
      .map((e) => e.field)
      .sort();
    expect(fields).toEqual(['assignee', 'priority', 'status', 'tags']);
    expect(detail.body.events[0].actor.id).toBe(w.billingAgent.id);
  });

  it('rejects forbidden transitions with 422', async () => {
    const t = await createTicket(w.as.customer);
    const res = await w.as.lead.patch(`/tickets/${t.id}`).send({ version: 0, status: 'closed' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('invalid_transition');
    const toNew = await w.as.lead.patch(`/tickets/${t.id}`).send({ version: 0, status: 'new' });
    expect(toNew.status).toBe(200); // no-op: already new
    expect(toNew.body.version).toBe(0);
  });

  it('closed tickets are terminal', async () => {
    const t = await createTicket(w.as.customer);
    let v = t.version;
    for (const status of ['resolved', 'closed'] as const) {
      const r = await w.as.lead.patch(`/tickets/${t.id}`).send({ version: v, status });
      expect(r.status).toBe(200);
      v = r.body.version;
    }
    const reopen = await w.as.lead.patch(`/tickets/${t.id}`).send({ version: v, status: 'open' });
    expect(reopen.status).toBe(422);
    expect(reopen.body.error.code).toBe('ticket_closed');
  });

  it('two concurrent updates with the same version: one wins, the other gets 409 with current state', async () => {
    const t = await createTicket(w.as.customer);
    const [a, b] = await Promise.all([
      w.as.billingAgent.patch(`/tickets/${t.id}`).send({ version: t.version, priority: 'high' }),
      w.as.lead.patch(`/tickets/${t.id}`).send({ version: t.version, priority: 'low' }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    const winner = a.status === 200 ? a : b;
    expect(loser.body.error.code).toBe('version_conflict');
    expect(loser.body.current.version).toBe(t.version + 1);
    expect(loser.body.current.priority).toBe(winner.body.priority);
    const detail = await w.as.lead.get(`/tickets/${t.id}`);
    expect(detail.body.ticket.priority).toBe(winner.body.priority);
    expect(detail.body.events).toHaveLength(1);
  });

  it('stale version is rejected with 409', async () => {
    const t = await createTicket(w.as.customer);
    await w.as.lead.patch(`/tickets/${t.id}`).send({ version: 0, priority: 'high' });
    const stale = await w.as.lead.patch(`/tickets/${t.id}`).send({ version: 0, priority: 'low' });
    expect(stale.status).toBe(409);
    expect(stale.body.current.priority).toBe('high');
  });

  it('agents may only assign themselves; assignee must be staff', async () => {
    const t = await createTicket(w.as.customer);
    const other = await w.as.billingAgent
      .patch(`/tickets/${t.id}`)
      .send({ version: 0, assigneeId: w.techAgent.id });
    expect(other.status).toBe(403);
    const customer = await w.as.lead
      .patch(`/tickets/${t.id}`)
      .send({ version: 0, assigneeId: w.customer.id });
    expect(customer.status).toBe(422);
    expect(customer.body.error.code).toBe('invalid_assignee');
    const self = await w.as.billingAgent
      .patch(`/tickets/${t.id}`)
      .send({ version: 0, assigneeId: w.billingAgent.id });
    expect(self.status).toBe(200);
  });

  it('agents cannot take a ticket already assigned to a colleague', async () => {
    const colleague = await createUser(ctx.db, 'agent', ['billing']);
    const colleagueAgent = await loginAs(ctx, colleague);
    const t = await createTicket(w.as.customer);
    const taken = await colleagueAgent
      .patch(`/tickets/${t.id}`)
      .send({ version: 0, assigneeId: colleague.id });
    expect(taken.status).toBe(200);
    const steal = await w.as.billingAgent
      .patch(`/tickets/${t.id}`)
      .send({ version: 1, assigneeId: w.billingAgent.id });
    expect(steal.status).toBe(403);
    const unassign = await w.as.billingAgent
      .patch(`/tickets/${t.id}`)
      .send({ version: 1, assigneeId: null });
    expect(unassign.status).toBe(403);
  });

  it('assigning notifies the assignee', async () => {
    const t = await createTicket(w.as.customer);
    await w.as.lead.patch(`/tickets/${t.id}`).send({ version: 0, assigneeId: w.billingAgent.id });
    const { rows } = await ctx.pool.query(
      'select user_id, kind from notifications where ticket_id = $1',
      [t.id],
    );
    expect(rows).toEqual([{ user_id: w.billingAgent.id, kind: 'ticket_assigned' }]);
  });
});

describe('SLA on update', () => {
  it('priority change recomputes deadlines from creation time', async () => {
    const t = await createTicket(w.as.customer, { priority: 'normal' });
    expect(t.firstResponseDueAt).toBe('2025-01-13T15:00:00.000Z'); // Mon 17:00
    ctx.clock.set('2025-01-13T08:00:00.000Z'); // Mon 10:00
    const res = await w.as.lead.patch(`/tickets/${t.id}`).send({ version: 0, priority: 'urgent' });
    // urgent: 1h / 4h from Fri 17:00 -> Fri 18:00 / Mon 12:00
    expect(res.body.firstResponseDueAt).toBe('2025-01-10T16:00:00.000Z');
    expect(res.body.resolutionDueAt).toBe('2025-01-13T10:00:00.000Z');
    // already past the new first-response deadline -> breached
    expect(res.body.slaBreachedFirst).toBe(true);
  });

  it('pending pauses timers and shifts deadlines by the paused business time', async () => {
    const t = await createTicket(w.as.customer, { priority: 'high' });
    ctx.clock.set('2025-01-13T07:00:00.000Z'); // Mon 09:00 -> pending
    const p = await w.as.lead.patch(`/tickets/${t.id}`).send({ version: 0, status: 'pending' });
    expect(p.body.slaPaused).toBe(true);
    expect(p.body.nextDueAt).toBeNull();
    ctx.clock.set('2025-01-13T08:30:00.000Z'); // Mon 10:30 -> open again (90 min paused)
    const o = await w.as.lead.patch(`/tickets/${t.id}`).send({ version: 1, status: 'open' });
    expect(o.body.slaPaused).toBe(false);
    expect(o.body.firstResponseDueAt).toBe('2025-01-13T11:30:00.000Z'); // Mon 13:30
    expect(o.body.resolutionDueAt).toBe('2025-01-14T07:30:00.000Z'); // Tue 09:30
    expect(o.body.nextDueAt).toBe('2025-01-13T11:30:00.000Z');
  });
});

describe('customer actions', () => {
  it('resolve and rate', async () => {
    const t = await createTicket(w.as.customer);
    const early = await w.as.customer.post(`/tickets/${t.id}/rating`).send({ score: 5 });
    expect(early.status).toBe(422);
    const r = await w.as.customer.post(`/tickets/${t.id}/resolve`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('resolved');
    const rate = await w.as.customer
      .post(`/tickets/${t.id}/rating`)
      .send({ score: 4, comment: 'Thanks' });
    expect(rate.status).toBe(200);
    expect(rate.body.rating).toMatchObject({ score: 4, comment: 'Thanks' });
    const bad = await w.as.customer.post(`/tickets/${t.id}/rating`).send({ score: 6 });
    expect(bad.status).toBe(400);
    expect((await w.as.customer2.post(`/tickets/${t.id}/resolve`)).status).toBe(404);
  });

  it('read markers drive unread', async () => {
    const t = await createTicket(w.as.customer);
    await w.as.billingAgent.post(`/tickets/${t.id}/read`).expect(204);
    const detail = await w.as.billingAgent.get(`/tickets/${t.id}`);
    expect(detail.body.ticket.unread).toBe(false);
  });
});
