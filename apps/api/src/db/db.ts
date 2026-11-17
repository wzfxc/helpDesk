import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, types } from 'pg';
import * as schema from './schema.js';

// bigint/count(*) -> number (all our counts fit comfortably).
types.setTypeParser(types.builtins.INT8, (v) => Number(v));
types.setTypeParser(types.builtins.NUMERIC, (v) => Number(v));

export type Db = NodePgDatabase<typeof schema>;
/** Either the root db or a transaction handle. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

export const PG_POOL = Symbol('PG_POOL');
export const DB = Symbol('DB');

export interface PoolTimeouts {
  /** Server-side cap per statement: a heavy query is cancelled (SQLSTATE 57014) instead of hanging the api. */
  statementTimeoutMs?: number;
  /** A session left idle inside a transaction is terminated by the server. */
  idleInTransactionTimeoutMs?: number;
  /** Waiting for a free pooled connection longer than this fails instead of queueing forever. */
  connectionTimeoutMs?: number;
}

export function createPool(connectionString: string, max = 20, timeouts: PoolTimeouts = {}): Pool {
  return new Pool({
    connectionString,
    max,
    application_name: 'helpdesk-api',
    ...(timeouts.statementTimeoutMs ? { statement_timeout: timeouts.statementTimeoutMs } : {}),
    ...(timeouts.idleInTransactionTimeoutMs
      ? { idle_in_transaction_session_timeout: timeouts.idleInTransactionTimeoutMs }
      : {}),
    ...(timeouts.connectionTimeoutMs
      ? { connectionTimeoutMillis: timeouts.connectionTimeoutMs }
      : {}),
  });
}

export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema });
}

export { schema };
