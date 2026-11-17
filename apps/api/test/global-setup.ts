import { Pool } from 'pg';
import { runMigrations } from '../src/db/migrate.js';
import { TEST_DATABASE_URL } from './env.js';

/** Recreates the test database schema once per `vitest run` and applies migrations. */
export default async function setup(): Promise<void> {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
  try {
    await pool.query('drop schema if exists public cascade');
    await pool.query('drop schema if exists drizzle cascade');
    await pool.query('create schema public');
    await runMigrations(pool);
  } catch (err) {
    throw new Error(
      `Cannot prepare test database at ${TEST_DATABASE_URL}. Start it with "pnpm db:test:up". ${String(err)}`,
    );
  } finally {
    await pool.end();
  }
}
