import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { loadConfig } from './config.js';
import { createPool } from './db/db.js';
import { runMigrations } from './db/migrate.js';
import { seed } from './db/seed/seed.js';

/** Migrations always run on start; the seed only when SEED_ON_START=true and the db is empty. */
async function prepareDatabase(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL, 2);
  try {
    await runMigrations(pool);
    if (config.SEED_ON_START) {
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
    }
  } finally {
    await pool.end();
  }
}

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  await prepareDatabase();
  const app = await NestFactory.create(AppModule.forRoot(), { bodyParser: false });
  configureApp(app, config.TRUST_PROXY);
  app.enableShutdownHooks();
  await app.listen(config.API_PORT, '0.0.0.0');
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
