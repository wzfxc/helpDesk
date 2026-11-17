import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { createDb } from './db.js';

/** Works both from src (vitest) and dist (node): migrations live in apps/api/drizzle. */
export const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'drizzle');

export async function runMigrations(pool: Pool): Promise<void> {
  await migrate(createDb(pool), { migrationsFolder: MIGRATIONS_DIR });
}

/** Number of migrations in the journal vs applied in the database. */
export async function migrationStatus(pool: Pool): Promise<{ expected: number; applied: number }> {
  const journal = JSON.parse(
    await readFile(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: unknown[] };
  const res = await pool.query<{ count: number }>(
    `select count(*)::int as count from drizzle.__drizzle_migrations`,
  );
  return { expected: journal.entries.length, applied: res.rows[0]?.count ?? 0 };
}
