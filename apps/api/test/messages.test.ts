import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  STATUSES,
  TRANSITIONS,
  manualTargets,
  type Status,
  type TransitionTrigger,
} from '@helpdesk/shared';
import type TestAgent from 'supertest/lib/agent.js';
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
  ctx.clock.set('2025-01-07T08:00:00.000Z'); // Tue 10:00 Kyiv
  w = await createWorld(ctx);
});
afterAll(async () => {
  await ctx.close();
});

/** Puts a ticket into a given status directly (test setup only). */
async function forceStatus(id: string, status: Status): Promise<void> {
  await ctx.pool.query('update tickets set status = $2 where id = $1', [id, status]);
  if (status === 'pending' || status === 'resolved' || status === 'closed') {
    await ctx.pool.query(
      'insert into sla_pauses (ticket_id, started_at) values ($1, $2) on conflict do nothing',
      [id, ctx.clock.now()],
    );
    await ctx.pool.query(
      'update tickets set sla_paused_at = $2, next_due_at = null where id = $1',
      [id, ctx.clock.now()],
    );
  }
  if (status === 'resolved') {
    await ctx.pool.query('update tickets set resolved_at = $2 where id = $1', [
      id,
      ctx.clock.now(),
    ]);
  }
}

async function version(id: string): Promise<number> {
  const r = await ctx.pool.query<{ version: number }>('select version from tickets where id = $1', [
    id,
  ]);
  return r.rows[0]!.version;
}

const reply = (agent: TestAgent, id: string, body: Record<string, unknown> = {}) =>
  agent
    .post(`/tickets/${id}/messages`)
    .send({ clientMessageId: randomUUID(), body: 'Hello', ...body });

describe('status transitions (every row of the matrix)', () => {
  const cases = TRANSITIONS.filter((r) => r.trigger !== 'auto_close');

  it.each(cases.map((r) => [r.from, r.to, r.trigger] as const))(
    '%s -> %s via %s',
    async (from, to, trigger: TransitionTrigger) => {
      const t = await createTicket(w.as.customer);
      await forceStatus(t.id, from);
      let res;
      switch (trigger) {
        case 'staff_manual':
          res = await w.as.lead
            .patch(`/tickets/${t.id}`)
            .send({ version: await version(t.id), status: to });
          expect(res.status).toBe(200);
          expect(res.body.status).toBe(to);
          return;
        case 'staff_public_reply':
          res = await reply(w.as.billingAgent, t.id);
          break;
        case 'staff_reply_pending':
          res = await reply(w.as.billingAgent, t.id, { followUp: 'pending' });
          break;
        case 'staff_reply_resolve':
          res = await reply(w.as.billingAgent, t.id, { followUp: 'resolved' });
          break;
        case 'customer_reply':
          res = await reply(w.as.customer, t.id);
          break;
        case 'customer_resolve':
          res = await w.as.customer.post(`/tickets/${t.id}/resolve`);
          expect(res.status).toBe(200);
          expect(res.body.status).toBe(to);
          return;
        case 'auto_close':
          throw new Error('covered by jobs tests');
      }
      expect(res.status).toBe(201);
      expect(res.body.ticket.status).toBe(to);
      const events = await ctx.pool.query(
        `select from_value, to_value from ticket_events where ticket_id = $1 and field = 'status'`,
        [t.id],
      );
      expect(events.rows).toEqual([{ from_value: from, to_value: to }]);
    },
  );

  const forbidden: [Status, Status][] = [];
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      if (from !== to && !manualTargets(from).includes(to)) forbidden.push([from, to]);
    }
  }

  it.each(forbidden)('manual %s -> %s is rejected with 422', async (from, to) => {
    const t = await createTicket(w.as.customer);
    await forceStatus(t.id, from);
    const res = await w.as.lead
      .patch(`/tickets/${t.id}`)
      .send({ version: await version(t.id), status: to });
    expect(res.status).toBe(422);
    expect(['invalid_transition', 'ticket_closed']).toContain(res.body.error.code);
    const after = await ctx.pool.query('select status from tickets where id = $1', [t.id]);
    expect(after.rows[0].status).toBe(from);
  });

  it('replies without a matching rule keep the status', async () => {
    const t = await createTicket(w.as.customer);
    await forceStatus(t.id, 'open');
    expect((await reply(w.as.customer, t.id)).body.ticket.status).toBe('open');
    expect((await reply(w.as.billingAgent, t.id)).body.ticket.status).toBe('open');
    await forceStatus(t.id, 'resolved');
    expect((await reply(w.as.billingAgent, t.id)).body.ticket.status).toBe('resolved');
  });

  it('staff cannot reply to closed tickets', async () => {
    const t = await createTicket(w.as.customer);
    await forceStatus(t.id, 'closed');
    const res = await reply(w.as.billingAgent, t.id);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ticket_closed');
    const note = await reply(w.as.billingAgent, t.id, { internal: true });
    expect(note.status).toBe(422);
  });

  it('pending -> resolved by staff reply follow-up is rejected when not allowed', async () => {
    const t = await createTicket(w.as.customer);
    await forceStatus(t.id, 'resolved');
    const res = await reply(w.as.billingAgent, t.id, { followUp: 'resolved' });
    expect(res.status).toBe(201); // already resolved: keep
    expect(res.body.ticket.status).toBe('resolved');
  });
});

describe('replies', () => {
  it('first public staff reply sets first_responded_at and switches to the resolution deadline', async () => {
    const t = await createTicket(w.as.customer, { priority: 'high' });
    expect(t.firstResponseDueAt).not.toBeNull();
    ctx.clock.advance(30 * 60_000);
    const res = await reply(w.as.billingAgent, t.id);
    expect(res.body.ticket.firstRespondedAt).toBe(ctx.clock.now().toISOString());
    expect(res.body.ticket.nextDueAt).toBe(res.body.ticket.resolutionDueAt);
    expect(res.body.ticket.slaBreachedFirst).toBe(false);
  });

  it('a late first reply marks the first-response breach', async () => {
    const t = await createTicket(w.as.customer, { priority: 'high' });
    ctx.clock.advance(2 * 24 * 3_600_000);
    const res = await reply(w.as.billingAgent, t.id);
    expect(res.body.ticket.slaBreachedFirst).toBe(true);
  });

  it('customer reply notifies the assignee', async () => {
    const t = await createTicket(w.as.customer);
    await w.as.billingAgent
      .patch(`/tickets/${t.id}`)
      .send({ version: 0, assigneeId: w.billingAgent.id });
    await reply(w.as.customer, t.id);
    const { rows } = await ctx.pool.query(
      `select kind from notifications where user_id = $1 and kind = 'customer_replied'`,
      [w.billingAgent.id],
    );
    expect(rows).toHaveLength(1);
  });

  it('validates input', async () => {
    const t = await createTicket(w.as.customer);
    const noId = await w.as.customer.post(`/tickets/${t.id}/messages`).send({ body: 'x' });
    expect(noId.status).toBe(400);
    const empty = await reply(w.as.customer, t.id, { body: '   ' });
    expect(empty.status).toBe(400);
    const tooLong = await reply(w.as.customer, t.id, { body: 'x'.repeat(20_001) });
    expect(tooLong.status).toBe(400);
    const sixFiles = await reply(w.as.customer, t.id, {
      attachmentIds: Array.from({ length: 6 }, () => randomUUID()),
    });
    expect(sixFiles.status).toBe(400);
  });
});

describe('internal notes', () => {
  it('are hidden from the customer and do not change status', async () => {
    const t = await createTicket(w.as.customer);
    const note = await reply(w.as.billingAgent, t.id, { internal: true, body: 'secret note' });
    expect(note.status).toBe(201);
    expect(note.body.ticket.status).toBe('new');
    expect(note.body.message.internal).toBe(true);

    const asCustomer = await w.as.customer.get(`/tickets/${t.id}`);
    expect(asCustomer.body.messages.map((m: { body: string }) => m.body)).not.toContain(
      'secret note',
    );
    const asStaff = await w.as.billingAgent.get(`/tickets/${t.id}`);
    expect(asStaff.body.messages.map((m: { body: string }) => m.body)).toContain('secret note');
  });

  it('customers cannot post notes or choose a follow-up status', async () => {
    const t = await createTicket(w.as.customer);
    expect((await reply(w.as.customer, t.id, { internal: true })).status).toBe(403);
    expect((await reply(w.as.customer, t.id, { followUp: 'resolved' })).status).toBe(403);
  });
});

describe('idempotency', () => {
  it('a repeated clientMessageId returns the same message without side effects', async () => {
    const t = await createTicket(w.as.customer);
    const clientMessageId = randomUUID();
    const first = await reply(w.as.billingAgent, t.id, { clientMessageId });
    const second = await reply(w.as.billingAgent, t.id, { clientMessageId });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.message.id).toBe(first.body.message.id);
    expect(second.body).toEqual(first.body);
    const count = await ctx.pool.query(
      'select count(*)::int as n from messages where client_message_id = $1',
      [clientMessageId],
    );
    expect(count.rows[0].n).toBe(1);
    const events = await ctx.pool.query(
      `select count(*)::int as n from ticket_events where ticket_id = $1 and field = 'status'`,
      [t.id],
    );
    expect(events.rows[0].n).toBe(1);
  });

  it('parallel duplicates create exactly one message and one status change', async () => {
    const t = await createTicket(w.as.customer);
    await forceStatus(t.id, 'pending');
    const clientMessageId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => reply(w.as.customer, t.id, { clientMessageId })),
    );
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(201));
    const ids = new Set(results.map((r) => r.body.message.id as string));
    expect(ids.size).toBe(1);
    const count = await ctx.pool.query(
      'select count(*)::int as n from messages where client_message_id = $1',
      [clientMessageId],
    );
    expect(count.rows[0].n).toBe(1);
    const events = await ctx.pool.query(
      `select count(*)::int as n from ticket_events where ticket_id = $1 and field = 'status'`,
      [t.id],
    );
    expect(events.rows[0].n).toBe(1);
  });

  it('rejects reusing a clientMessageId for another ticket', async () => {
    const a = await createTicket(w.as.customer);
    const b = await createTicket(w.as.customer);
    const clientMessageId = randomUUID();
    await reply(w.as.customer, a.id, { clientMessageId });
    const res = await reply(w.as.customer, b.id, { clientMessageId });
    expect(res.status).toBe(400);
  });
});

describe('reply to a closed ticket', () => {
  it('creates a new linked ticket and is idempotent (also in parallel)', async () => {
    const t = await createTicket(w.as.customer, { subject: 'Old problem', priority: 'high' });
    await forceStatus(t.id, 'closed');
    const clientMessageId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        reply(w.as.customer, t.id, { clientMessageId, body: 'It is broken again' }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    const newIds = new Set(results.map((r) => r.body.newTicketId as string));
    expect(newIds.size).toBe(1);
    const res = results[0]!;
    expect(res.body.newTicketId).not.toBe(t.id);
    expect(res.body.ticket).toMatchObject({
      id: res.body.newTicketId,
      status: 'new',
      subject: 'Old problem',
      parentTicketId: t.id,
      parentTicketNumber: t.number,
      priority: 'high',
    });
    expect(res.body.message.body).toBe('It is broken again');
    const old = await w.as.customer.get(`/tickets/${t.id}`);
    expect(old.body.ticket.status).toBe('closed');
    expect(old.body.messages).toHaveLength(1);
    const count = await ctx.pool.query(
      'select count(*)::int as n from tickets where parent_ticket_id = $1',
      [t.id],
    );
    expect(count.rows[0].n).toBe(1);
  });
});
