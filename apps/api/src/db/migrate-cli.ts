import { loadConfig } from '../config.js';
import { createPool } from './db.js';
import { runMigrations } from './migrate.js';

async function main(): Promise<void> {
  const pool = createPool(loadConfig().DATABASE_URL, 2);
  try {
    await runMigrations(pool);
    console.log('migrations applied');
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
