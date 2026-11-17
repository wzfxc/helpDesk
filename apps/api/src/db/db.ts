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

export function createPool(connectionString: string, max = 20): Pool {
  return new Pool({ connectionString, max, application_name: 'helpdesk-api' });
}

export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema });
}

export { schema };
