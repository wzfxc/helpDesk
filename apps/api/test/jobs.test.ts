import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_CONFIG, type AppConfig } from '../src/config.js';
import { JobHandlers } from '../src/jobs/handlers.js';
import { JobQueue, JOB_LEASE_MS } from '../src/jobs/job-queue.js';
import { JobWorker, PERIODIC_TASKS } from '../src/jobs/worker.js';
import { createTestApp, type TestContext } from './app.js';
import { resetDb } from './db.js';
import { createTicket, createWorld, PNG, upload, type World } from './fixtures.js';

let ctx: TestContext;
let w: World;
let handlers: JobHandlers;
let worker: JobWorker;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

beforeAll(async () => {
  ctx = await createTestApp();
  handlers = ctx.app.get(JobHandlers);
  worker = ctx.app.get(JobWorker);
});
beforeEach(async () => {
  await resetDb(ctx.pool);
  ctx.clock.set('2025-01-07T08:00:00.000Z'); // Tue 10:00 Kyiv
  w = await createWorld(ctx);
});
afterAll(async () => {
  await ctx.close();
});

const notificationsOf = async (userId: string, kind: string) =>
  (
    await ctx.pool.query('select * from notifications where user_id = $1 and kind = $2', [
      userId,
      kind,
    ])
  ).rows;

describe('auto-close', () => {
  it('closes resolved tickets after 3 days; a customer reply then creates a new ticket', async () => {
    const t = await createTicket(w.as.customer);
    const resolved = await w.as.customer.post(`/tickets/${t.id}/resolve`);
    expect(resolved.body.status).toBe('resolved');

    ctx.clock.advance(3 * DAY - 60_000);
    expect(await handlers.autoClose()).toBe(0);

    ctx.clock.advance(2 * 60_000);
    expect(await handlers.autoClose()).toBe(1);
    expect(await handlers.autoClose()).toBe(0); // idempotent

    const detail = await w.as.lead.get(`/tickets/${t.id}`);
    expect(detail.body.ticket.status).toBe('closed');
    expect(detail.body.ticket.closedAt).toBe(ctx.clock.now().toISOString());
    const closeEvent = (detail.body.events as { field: string; to: string; actor: unknown }[]).find(
      (e) => e.field === 'status' && e.to === 'closed',
    );
    expect(closeEvent?.actor).toBeNull(); // system

    const res = await w.as.customer
      .post(`/tickets/${t.id}/messages`)
      .send({ clientMessageId: randomUUID(), body: 'Still broken' });
    expect(res.status).toBe(201);
    expect(res.body.newTicketId).toBeTruthy();
    expect(res.body.ticket.parentTicketId).toBe(t.id);
  });

  it('does not close tickets reopened by the customer', async () => {
    const t = await createTicket(w.as.customer);
    await w.as.customer.post(`/tickets/${t.id}/resolve`);
    ctx.clock.advance(DAY);
    await w.as.customer
      .post(`/tickets/${t.id}/messages`)
      .send({ clientMessageId: randomUUID(), body: 'wait' });
    ctx.clock.advance(5 * DAY);
    expect(await handlers.autoClose()).toBe(0);
  });
});

describe('SLA scan', () => {
  it('warns the assignee 30 minutes before the deadline exactly once', async () => {
    // urgent is staff-only: create normal, then raise priority
    const t = await createTicket(w.as.customer, { priority: 'normal' });
    await w.as.lead
      .patch(`/tickets/${t.id}`)
      .send({ version: 0, priority: 'urgent', assigneeId: w.billingAgent.id });
    // first response due in 60 business minutes (11:00 Kyiv)
    ctx.clock.advance(20 * 60_000);
    expect((await handlers.slaScan()).warnings).toBe(0);
    ctx.clock.advance(15 * 60_000); // 25 minutes left
    expect((await handlers.slaScan()).warnings).toBe(1);
    expect((await handlers.slaScan()).warnings).toBe(0);
    const warns = await notificationsOf(w.billingAgent.id, 'sla_warning');
    expect(warns).toHaveLength(1);
    expect(new Date(warns[0].due_at).toISOString()).toBe('2025-01-07T09:00:00.000Z');
  });

  it('flags breaches once and notifies the assignee, or leads when unassigned', async () => {
    const assigned = await createTicket(w.as.customer, { priority: 'high' });
    await w.as.lead
      .patch(`/tickets/${assigned.id}`)
      .send({ version: 0, assigneeId: w.billingAgent.id });
    const unassigned = await createTicket(w.as.customer, { priority: 'high' });
    ctx.clock.advance(5 * HOUR); // past the 4h first-response deadline
    const first = await handlers.slaScan();
    expect(first.breaches).toBe(2);
    expect((await handlers.slaScan()).breaches).toBe(0);

    const a = await w.as.lead.get(`/tickets/${assigned.id}`);
    expect(a.body.ticket.slaBreachedFirst).toBe(true);
    expect(await notificationsOf(w.billingAgent.id, 'sla_breached')).toHaveLength(1);
    const leadNotes = await notificationsOf(w.lead.id, 'sla_breached');
    expect(leadNotes.map((n: { ticket_id: string }) => n.ticket_id)).toEqual([unassigned.id]);

    const list = await ctx.pool.query(
      'select count(*)::int as n from tickets where sla_breached_first',
    );
    expect(list.rows[0].n).toBe(2);
  });

  it('ignores paused tickets', async () => {
    const t = await createTicket(w.as.customer, { priority: 'high' });
    await w.as.lead.patch(`/tickets/${t.id}`).send({ version: 0, status: 'pending' });
    ctx.clock.advance(3 * DAY);
    expect(await handlers.slaScan()).toEqual({ warnings: 0, breaches: 0 });
  });
});

describe('attachment cleanup', () => {
  it('deletes unbound attachments older than 24h from disk and database', async () => {
    const old = await upload(w.as.customer, PNG, 'old.png');
    const bound = await upload(w.as.customer, PNG, 'bound.png');
    await createTicket(w.as.customer, { attachmentIds: [bound.body.id] });
    ctx.clock.advance(23 * HOUR);
    const fresh = await upload(w.as.customer, PNG, 'fresh.png');
    const key = (
      await ctx.pool.query<{ storage_key: string }>(
        'select storage_key from attachments where id = $1',
        [old.body.id],
      )
    ).rows[0]!.storage_key;
    const file = path.resolve('./data/test-attachments', key);
    expect(existsSync(file)).toBe(true);

    ctx.clock.advance(2 * HOUR);
    expect(await handlers.cleanupAttachments()).toBe(1);
    expect(existsSync(file)).toBe(false);
    const left = await ctx.pool.query<{ id: string }>('select id from attachments order by id');
    expect(left.rows.map((r) => r.id).sort()).toEqual([bound.body.id, fresh.body.id].sort());
    expect(await handlers.cleanupAttachments()).toBe(0);
  });
});

describe('queue and scheduler', () => {
  it('schedules each periodic task once per slot, also after a restart', async () => {
    expect(await worker.schedule()).toBe(PERIODIC_TASKS.length);
    expect(await worker.schedule()).toBe(0);
    // "restart": a fresh worker with another id in the same slot schedules nothing new
    const config = ctx.app.get<AppConfig>(APP_CONFIG);
    const restarted = new JobWorker(config, new JobQueue(ctx.db, ctx.clock), handlers, ctx.clock);
    expect(await restarted.schedule()).toBe(0);
    // ...and both workers draining together execute every job exactly once
    const [a, b] = await Promise.all([worker.drain(), restarted.drain()]);
    expect(a + b).toBe(PERIODIC_TASKS.length);
    const done = await ctx.pool.query(
      `select count(*)::int as n from jobs where status = 'done' and attempts = 1`,
    );
    expect(done.rows[0].n).toBe(PERIODIC_TASKS.length);
    // next slot
    ctx.clock.advance(60_000);
    expect(await worker.schedule()).toBeGreaterThanOrEqual(1);
  });

  it('reclaims jobs whose worker died (expired lease) and runs them once', async () => {
    const queue = ctx.app.get(JobQueue);
    await queue.enqueue('housekeeping', {}, { dedupeKey: 'hk-test' });
    const crashed = new JobQueue(ctx.db, ctx.clock);
    const claimed = await crashed.claim();
    expect(claimed?.type).toBe('housekeeping');
    expect(await worker.runOnce()).toBe(false); // still leased
    ctx.clock.advance(JOB_LEASE_MS + 1000);
    expect(await worker.runOnce()).toBe(true);
    // the crashed worker finishing late does not overwrite the new owner's result
    await crashed.complete(claimed!);
    const row = await ctx.pool.query('select status, attempts, locked_by from jobs');
    expect(row.rows[0]).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('retries failed jobs with backoff and gives up after max attempts', async () => {
    const queue = ctx.app.get(JobQueue);
    await queue.enqueue('no-such-job', {}, { maxAttempts: 2 });
    expect(await worker.runOnce()).toBe(true);
    let row = (await ctx.pool.query('select * from jobs')).rows[0];
    expect(row.status).toBe('queued');
    expect(new Date(row.run_at).getTime()).toBeGreaterThan(ctx.clock.now().getTime());
    expect(await worker.runOnce()).toBe(false); // backoff not elapsed
    ctx.clock.advance(60_000);
    expect(await worker.runOnce()).toBe(true);
    row = (await ctx.pool.query('select * from jobs')).rows[0];
    expect(row.status).toBe('failed');
    expect(row.last_error).toContain('unknown job type');
  });

  it('a background worker processes scheduled jobs and stops cleanly', async () => {
    const t = await createTicket(w.as.customer);
    await w.as.customer.post(`/tickets/${t.id}/resolve`);
    ctx.clock.advance(4 * DAY);
    worker.start();
    for (let i = 0; i < 50; i++) {
      const r = await ctx.pool.query('select status from tickets where id = $1', [t.id]);
      if (r.rows[0].status === 'closed') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await worker.stop();
    const r = await ctx.pool.query('select status from tickets where id = $1', [t.id]);
    expect(r.rows[0].status).toBe('closed');
  });
});
