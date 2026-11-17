import { loadConfig } from '../config.js';
import { createPool } from './db.js';
import { seed } from './seed/seed.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL, 4);
  try {
    await seed(pool, {
      tickets: config.SEED_TICKETS,
      customers: 200,
      passwords: {
        customer: config.SEED_CUSTOMER_PASSWORD,
        agent: config.SEED_AGENT_PASSWORD,
        lead: config.SEED_LEAD_PASSWORD,
      },
      log: (m) => {
        console.log(m);
      },
    });
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
