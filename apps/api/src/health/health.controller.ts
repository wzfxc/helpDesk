import { Controller, Get, HttpCode, Inject, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { Pool } from 'pg';
import { Public } from '../auth/decorators.js';
import { PG_POOL } from '../db/db.js';
import { migrationStatus } from '../db/migrate.js';

@ApiTags('health')
@Public()
@Controller()
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Liveness: the process is up and serving HTTP. */
  @Get('health')
  @HttpCode(200)
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: database reachable and all migrations applied. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<Record<string, unknown>> {
    try {
      const { expected, applied } = await migrationStatus(this.pool);
      const ok = applied >= expected;
      res.status(ok ? 200 : 503);
      return { status: ok ? 'ready' : 'migrations_pending', migrations: { expected, applied } };
    } catch {
      res.status(503);
      return { status: 'database_unavailable' };
    }
  }
}
