import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  LIMITS,
  type TicketListQuery,
  type TicketListResponse,
  type TicketSort,
} from '@helpdesk/shared';
import type { AuthUser } from '../auth/auth.types.js';
import { ApiError } from '../common/errors.js';
import type { DbOrTx } from '../db/db.js';
import { messageVisibility, toTextArray } from './ticket-access.js';
import { selectTickets, type SelectTicketsOptions } from './ticket-query.js';

const SORT_COLUMNS: Record<'sla' | 'created' | 'updated', string> = {
  sla: 't.sla_sort_at',
  created: 't.created_at',
  updated: 't.updated_at',
};

const CursorSchema = z.object({
  s: z.enum(['sla', '-sla', 'created', '-created', 'updated', '-updated']),
  /** Sort key as PostgreSQL text (keeps microsecond precision). */
  v: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[0-9 :.+-]+$/),
  id: z.uuid(),
});
type Cursor = z.infer<typeof CursorSchema>;

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

export function decodeCursor(raw: string, sort: TicketSort): Cursor {
  const invalid = () => new ApiError(400, 'invalid_cursor', 'Invalid cursor');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  const r = CursorSchema.safeParse(parsed);
  // A cursor is only valid for the sort order it was produced with.
  if (!r.success || r.data.s !== sort) throw invalid();
  return r.data;
}

/**
 * Full-text query for the `simple` configuration: words are reduced to letters/digits and
 * matched as prefixes (`pay` finds "payment"); all words must match.
 */
export function toTsQuery(q: string): string | null {
  const words = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0)
    .slice(0, 8);
  return words.length ? words.map((w) => `${w}:*`).join(' & ') : null;
}

export const defaultSort = (viewer: AuthUser): TicketSort =>
  viewer.role === 'customer' ? '-updated' : 'sla';

/** WHERE conditions for filters (the permission scope is added by selectTickets). */
export function filterConditions(viewer: AuthUser, q: TicketListQuery, now: Date): SQL[] {
  const where: SQL[] = [];
  if (q.status?.length) where.push(sql`t.status = any(${toTextArray(q.status)})`);
  if (q.priority?.length) where.push(sql`t.priority = any(${toTextArray(q.priority)})`);
  if (q.category?.length) where.push(sql`t.category = any(${toTextArray(q.category)})`);
  if (q.assignee === 'me') where.push(sql`t.assignee_id = ${viewer.id}`);
  else if (q.assignee === 'none') where.push(sql`t.assignee_id is null`);
  else if (q.assignee) where.push(sql`t.assignee_id = ${q.assignee}`);
  if (q.slaBreached === true) where.push(sql`(t.sla_breached_first or t.sla_breached_resolution)`);
  if (q.slaBreached === false) {
    where.push(sql`not (t.sla_breached_first or t.sla_breached_resolution)`);
  }
  if (q.slaRisk === true) {
    where.push(sql`t.sla_sort_at <= ${new Date(now.getTime() + LIMITS.slaRiskMinutes * 60_000)}`);
  }
  if (q.tags?.length) where.push(sql`t.tags @> ${toTextArray(q.tags)}`);
  if (q.createdFrom) where.push(sql`t.created_at >= ${new Date(q.createdFrom)}`);
  if (q.createdTo) where.push(sql`t.created_at < ${new Date(q.createdTo)}`);
  if (q.q) {
    const ts = toTsQuery(q.q);
    const numberMatch = /^\s*(?:hd-?)?(\d{1,9})\s*$/i.exec(q.q);
    const parts: SQL[] = [];
    if (ts) {
      // Ticket ids whose subject or (visible) messages match. Internal notes are excluded
      // for customers *inside* the subquery, so a note's text can never surface a ticket.
      parts.push(sql`t.id in (
        select s.id from tickets s where s.search_vector @@ to_tsquery('simple', ${ts})
        union
        select m.ticket_id from messages m
        where m.search_vector @@ to_tsquery('simple', ${ts}) and ${messageVisibility(viewer)}
      )`);
    }
    if (numberMatch?.[1]) parts.push(sql`t.number = ${Number(numberMatch[1])}`);
    // A query without searchable words matches nothing (rather than everything).
    where.push(parts.length ? sql`(${sql.join(parts, sql` or `)})` : sql`false`);
  }
  return where;
}

export function sortSql(sort: TicketSort): { column: SQL; dir: 'asc' | 'desc' } {
  const desc = sort.startsWith('-');
  const key = (desc ? sort.slice(1) : sort) as keyof typeof SORT_COLUMNS;
  return { column: sql.raw(SORT_COLUMNS[key]), dir: desc ? 'desc' : 'asc' };
}

/** Options for selectTickets that implement a list request (shared with the bench). */
export function listQueryOptions(
  viewer: AuthUser,
  query: TicketListQuery,
  now: Date,
): SelectTicketsOptions & { sort: TicketSort; limit: number } {
  const sort = query.sort ?? defaultSort(viewer);
  const { column, dir } = sortSql(sort);
  const where = filterConditions(viewer, query, now);
  if (query.cursor) {
    const c = decodeCursor(query.cursor, sort);
    where.push(
      dir === 'asc'
        ? sql`(${column}, t.id) > (${c.v}::timestamptz, ${c.id}::uuid)`
        : sql`(${column}, t.id) < (${c.v}::timestamptz, ${c.id}::uuid)`,
    );
  }
  return {
    sort,
    where: where.length ? sql.join(where, sql` and `) : undefined,
    orderBy: dir === 'asc' ? sql`${column} asc, t.id asc` : sql`${column} desc, t.id desc`,
    limit: query.limit + 1,
    sortValue: column,
  };
}

/**
 * Keyset pagination on (sort_key, id): stable under concurrent inserts/updates and O(limit)
 * at any depth, unlike OFFSET.
 */
export async function listTickets(
  db: DbOrTx,
  viewer: AuthUser,
  query: TicketListQuery,
  now: Date,
): Promise<TicketListResponse> {
  const opts = listQueryOptions(viewer, query, now);
  const rows = await selectTickets(db, viewer, opts);
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > query.limit && last?.sortValue
      ? encodeCursor({ s: opts.sort, v: last.sortValue, id: last.ticket.id })
      : null;
  return { items: page.map((r) => r.ticket), nextCursor };
}
