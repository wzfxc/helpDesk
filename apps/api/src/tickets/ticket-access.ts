import { sql, type SQL } from 'drizzle-orm';
import type { AuthUser } from '../auth/auth.types.js';

/**
 * Row-level access policy, expressed as SQL so it is applied *inside* every query
 * (detail, list, search, attachments, take-next, bulk, SSE fan-out) rather than by
 * filtering results afterwards. `alias` is the tickets table alias used by the query.
 *
 * - customer: own tickets only
 * - agent: tickets of their categories, plus any ticket assigned to them
 * - lead: everything
 */
export function ticketScope(user: AuthUser, alias = 't'): SQL {
  const t = sql.raw(alias);
  switch (user.role) {
    case 'customer':
      return sql`${t}.customer_id = ${user.id}`;
    case 'agent':
      return sql`(${t}.category = any(${toTextArray(user.categories)}) or ${t}.assignee_id = ${user.id})`;
    case 'lead':
      return sql`true`;
  }
}

/** Customers never see internal notes (nor their attachments). */
export function messageVisibility(user: AuthUser, alias = 'm'): SQL {
  return user.role === 'customer' ? sql`not ${sql.raw(alias)}.internal` : sql`true`;
}

export function toTextArray(values: readonly string[]): SQL {
  return sql`${`{${values.map((v) => `"${v.replace(/["\\]/g, '\\$&')}"`).join(',')}}`}::text[]`;
}

export function toUuidArray(values: readonly string[]): SQL {
  return sql`${`{${values.join(',')}}`}::uuid[]`;
}
