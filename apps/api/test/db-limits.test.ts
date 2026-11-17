import { afterAll, describe, expect, it } from 'vitest';
import { LIMITS } from '@helpdesk/shared';
import { toApiError } from '../src/common/error.filter.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/db.js';
import { TEST_DATABASE_URL } from './env.js';

/** Resource limits: a heavy query must be cancelled by postgres and surface as a clean 503. */
const pools: ReturnType<typeof createPool>[] = [];
afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
});

describe('database guards', () => {
  it('statement_timeout cancels a long query (57014) and maps to 503 service_unavailable', async () => {
    const pool = createPool(TEST_DATABASE_URL, 1, { statementTimeoutMs: 150 });
    pools.push(pool);
    const err = await pool.query('select pg_sleep(2)').catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('57014');
    const api = toApiError(err);
    expect(api.getStatus()).toBe(503);
    expect(api.code).toBe('service_unavailable');
    expect(api.headers?.['Retry-After']).toBeDefined();
  });

  it('a pool without a free connection fails fast instead of waiting forever', async () => {
    const pool = createPool(TEST_DATABASE_URL, 1, { connectionTimeoutMs: 150 });
    pools.push(pool);
    const held = await pool.connect();
    const err = await pool.query('select 1').catch((e: unknown) => e);
    held.release();
    expect(toApiError(err).getStatus()).toBe(503);
  });

  it('defaults keep the pool plus extra connections below postgres max_connections', () => {
    const config = loadConfig({});
    expect(config.DB_STATEMENT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(config.DB_STATEMENT_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    // pool + LISTEN client + migration pool (2) < max_connections (100, docker-compose.yml)
    expect(config.DATABASE_POOL_MAX + 1 + 2).toBeLessThan(100);
    expect(LIMITS.sseMaxPerUser).toBeLessThan(config.DATABASE_POOL_MAX);
  });
});
