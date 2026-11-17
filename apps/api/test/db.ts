import { Pool } from 'pg';
import { createDb, type Db } from '../src/db/db.js';
import { TEST_DATABASE_URL } from './env.js';

export interface TestDb {
  pool: Pool;
  db: Db;
}

export function createTestDb(max = 30): TestDb {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL, max });
  return { pool, db: createDb(pool) };
}

const TABLES = [
  'notifications',
  'sla_alerts',
  'sla_pauses',
  'ticket_reads',
  'ticket_events',
  'attachments',
  'messages',
  'tickets',
  'sessions',
  'login_attempts',
  'canned_responses',
  'saved_views',
  'jobs',
  'users',
];

/** Wipes all data and restores bootstrap rows (counter + default SLA policies). */
export async function resetDb(pool: Pool): Promise<void> {
  await pool.query(`truncate ${TABLES.join(', ')} restart identity cascade`);
  await pool.query(`update ticket_counter set value = 1000 where id = 1`);
  await pool.query(`
    insert into sla_policies (priority, first_response_minutes, resolution_minutes) values
      ('urgent', 60, 240), ('high', 240, 540), ('normal', 540, 1620), ('low', 1080, 2700)
    on conflict (priority) do update set
      first_response_minutes = excluded.first_response_minutes,
      resolution_minutes = excluded.resolution_minutes`);
}
