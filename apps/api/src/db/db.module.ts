import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { createDb, createPool, DB, PG_POOL } from './db.js';

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Pool =>
        createPool(config.DATABASE_URL, config.DATABASE_POOL_MAX),
    },
    {
      provide: DB,
      inject: [PG_POOL],
      useFactory: createDb,
    },
  ],
  exports: [PG_POOL, DB],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
