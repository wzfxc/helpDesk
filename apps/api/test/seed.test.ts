import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seed } from '../src/db/seed/seed.js';
import { createTestDb, resetDb } from './db.js';

const { pool } = createTestDb(4);
const options = {
  tickets: 20_000,
  customers: 200,
  passwords: { customer: 'c', agent: 'a', lead: 'l' },
  now: new Date('2025-06-30T12:00:00Z'),
};

beforeAll(async () => {
  await resetDb(pool);
});
afterAll(async () => {
  await resetDb(pool);
  await pool.end();
});

describe('seed', () => {
  it('creates 20k tickets in under a minute', async () => {
    const result = await seed(pool, options);
    expect(result.skipped).toBe(false);
    expect(result.tickets).toBe(20_000);
    expect(result.ms).toBeLessThan(60_000);
  }, 120_000);

  it('creates the required users', async () => {
    const { rows } = await pool.query<{ role: string; count: number }>(
      'select role, count(*)::int as count from users group by role order by role',
    );
    expect(rows).toEqual([
      { role: 'agent', count: 6 },
      { role: 'customer', count: 200 },
      { role: 'lead', count: 1 },
    ]);
  });

  it('covers every status and priority and spans six months', async () => {
    const statuses = await pool.query<{ status: string }>('select distinct status from tickets');
    expect(statuses.rows.map((r) => r.status).sort()).toEqual(
      ['closed', 'new', 'open', 'pending', 'resolved'].sort(),
    );
    const priorities = await pool.query('select distinct priority from tickets');
    expect(priorities.rowCount).toBe(4);
    const span = await pool.query<{ days: number }>(
      `select extract(day from max(created_at) - min(created_at))::int as days from tickets`,
    );
    expect(span.rows[0]?.days).toBeGreaterThan(170);
    const misc = await pool.query<{
      notes: number;
      breached: number;
      rated: number;
      tagged: number;
    }>(`
      select
        (select count(*) from messages where internal)::int as notes,
        (select count(*) from tickets where sla_breached_first or sla_breached_resolution)::int as breached,
        (select count(*) from tickets where rating_score is not null)::int as rated,
        (select count(*) from tickets where cardinality(tags) > 0)::int as tagged`);
    const m = misc.rows[0];
    expect(m?.notes).toBeGreaterThan(0);
    expect(m?.breached).toBeGreaterThan(0);
    expect(m?.rated).toBeGreaterThan(0);
    expect(m?.tagged).toBeGreaterThan(0);
  });

  it('keeps ticket numbers contiguous and the counter consistent', async () => {
    const { rows } = await pool.query<{
      min: number;
      max: number;
      count: number;
      counter: number;
    }>(`
      select min(number)::int as min, max(number)::int as max, count(*)::int as count,
             (select value from ticket_counter) as counter
      from tickets`);
    const r = rows[0];
    expect(r?.max).toBe(r?.counter);
    expect((r?.max ?? 0) - (r?.min ?? 0) + 1).toBe(r?.count);
  });

  it('is idempotent', async () => {
    const again = await seed(pool, options);
    expect(again.skipped).toBe(true);
    const { rows } = await pool.query<{ count: number }>(
      'select count(*)::int as count from tickets',
    );
    expect(rows[0]?.count).toBe(20_000);
  });
});
