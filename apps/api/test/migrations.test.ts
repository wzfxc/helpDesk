import { afterAll, describe, expect, it } from 'vitest';
import { migrationStatus } from '../src/db/migrate.js';
import { createTestDb } from './db.js';

const { pool } = createTestDb(2);
afterAll(() => pool.end());

describe('migrations', () => {
  it('are all applied', async () => {
    const status = await migrationStatus(pool);
    expect(status.applied).toBe(status.expected);
    expect(status.expected).toBeGreaterThan(0);
  });

  it('bootstrap counter and SLA policies', async () => {
    const counter = await pool.query<{ value: number }>('select value from ticket_counter');
    expect(counter.rows).toHaveLength(1);
    const policies = await pool.query('select * from sla_policies');
    expect(policies.rowCount).toBe(4);
  });

  it('computes generated columns', async () => {
    const user = await pool.query<{ id: string }>(
      `insert into users (email, name, role, password_hash) values ('m@x.io', 'M', 'customer', 'x') returning id`,
    );
    const res = await pool.query<{ priority_rank: number; search_vector: string }>(
      `insert into tickets (number, subject, category, priority, customer_id, sla_sort_at)
       values (1, 'Payment failed', 'billing', 'urgent', $1, now())
       returning priority_rank, search_vector::text`,
      [user.rows[0]?.id],
    );
    expect(res.rows[0]?.priority_rank).toBe(3);
    expect(res.rows[0]?.search_vector).toContain('payment');
    await pool.query('delete from tickets; delete from users');
  });
});
