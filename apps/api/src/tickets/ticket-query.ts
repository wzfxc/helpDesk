import { sql, type SQL } from 'drizzle-orm';
import type { Category, Priority, Status, Ticket } from '@helpdesk/shared';
import type { AuthUser } from '../auth/auth.types.js';
import type { DbOrTx } from '../db/db.js';
import { ticketScope } from './ticket-access.js';

interface TicketDtoRow {
  id: string;
  number: number;
  subject: string;
  category: Category;
  priority: Priority;
  status: Status;
  tags: string[];
  version: number;
  customer_id: string;
  customer_name: string;
  customer_email: string;
  assignee_id: string | null;
  assignee_name: string | null;
  parent_ticket_id: string | null;
  parent_number: number | null;
  first_response_due_at: Date | null;
  resolution_due_at: Date | null;
  first_responded_at: Date | null;
  resolved_at: Date | null;
  closed_at: Date | null;
  next_due_at: Date | null;
  sla_paused_at: Date | null;
  sla_breached_first: boolean;
  sla_breached_resolution: boolean;
  last_message_at: Date;
  rating_score: number | null;
  rating_comment: string | null;
  rated_at: Date | null;
  created_at: Date;
  updated_at: Date;
  unread: boolean | null;
  sort_value?: string;
}

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

export function toTicketDto(r: TicketDtoRow): Ticket {
  return {
    id: r.id,
    number: r.number,
    subject: r.subject,
    category: r.category,
    priority: r.priority,
    status: r.status,
    tags: r.tags,
    version: r.version,
    customer: { id: r.customer_id, name: r.customer_name, email: r.customer_email },
    assignee: r.assignee_id ? { id: r.assignee_id, name: r.assignee_name ?? '' } : null,
    parentTicketId: r.parent_ticket_id,
    parentTicketNumber: r.parent_number,
    firstResponseDueAt: iso(r.first_response_due_at),
    resolutionDueAt: iso(r.resolution_due_at),
    firstRespondedAt: iso(r.first_responded_at),
    resolvedAt: iso(r.resolved_at),
    closedAt: iso(r.closed_at),
    nextDueAt: iso(r.next_due_at),
    slaPaused: r.sla_paused_at !== null,
    slaBreachedFirst: r.sla_breached_first,
    slaBreachedResolution: r.sla_breached_resolution,
    lastMessageAt: new Date(r.last_message_at).toISOString(),
    unread: r.unread === true,
    rating:
      r.rating_score !== null && r.rated_at
        ? {
            score: r.rating_score,
            comment: r.rating_comment,
            createdAt: new Date(r.rated_at).toISOString(),
          }
        : null,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export interface SelectTicketsOptions {
  where?: SQL | undefined;
  orderBy?: SQL | undefined;
  limit?: number | undefined;
  /** Extra select expression returned as `sort_value` (keyset cursor). */
  sortValue?: SQL | undefined;
  /** Skip the permission scope — only for internal callers (jobs, SSE fan-out by recipient). */
  unscoped?: boolean;
}

/**
 * The single query that produces Ticket DTOs. Permission scope is always part of the WHERE
 * clause unless explicitly disabled by internal code paths.
 */
export function ticketsQuery(viewer: AuthUser, opts: SelectTicketsOptions = {}): SQL {
  const conditions: SQL[] = [];
  if (!opts.unscoped) conditions.push(ticketScope(viewer));
  if (opts.where) conditions.push(opts.where);
  const where = conditions.length ? sql.join(conditions, sql` and `) : sql`true`;
  const unreadSource =
    viewer.role === 'customer' ? sql`t.last_staff_reply_at` : sql`t.last_customer_message_at`;

  return sql`
    select t.id, t.number, t.subject, t.category, t.priority, t.status, t.tags, t.version,
      t.customer_id, c.name as customer_name, c.email as customer_email,
      t.assignee_id, a.name as assignee_name,
      t.parent_ticket_id, p.number as parent_number,
      t.first_response_due_at, t.resolution_due_at, t.first_responded_at, t.resolved_at,
      t.closed_at, t.next_due_at, t.sla_paused_at, t.sla_breached_first, t.sla_breached_resolution,
      t.last_message_at, t.rating_score, t.rating_comment, t.rated_at, t.created_at, t.updated_at,
      (${unreadSource} > coalesce(r.last_read_at, '-infinity'::timestamptz)) as unread
      ${opts.sortValue ? sql`, (${opts.sortValue})::text as sort_value` : sql``}
    from tickets t
    join users c on c.id = t.customer_id
    left join users a on a.id = t.assignee_id
    left join tickets p on p.id = t.parent_ticket_id
    left join ticket_reads r on r.ticket_id = t.id and r.user_id = ${viewer.id}
    where ${where}
    ${opts.orderBy ? sql`order by ${opts.orderBy}` : sql``}
    ${opts.limit !== undefined ? sql`limit ${opts.limit}` : sql``}
  `;
}

export async function selectTickets(
  db: DbOrTx,
  viewer: AuthUser,
  opts: SelectTicketsOptions = {},
): Promise<{ ticket: Ticket; sortValue: string | undefined }[]> {
  const res = await db.execute<TicketDtoRow & Record<string, unknown>>(ticketsQuery(viewer, opts));
  return res.rows.map((r) => ({
    ticket: toTicketDto(r),
    sortValue: r.sort_value ?? undefined,
  }));
}

export async function selectTicketById(
  db: DbOrTx,
  viewer: AuthUser,
  id: string,
  opts: { unscoped?: boolean } = {},
): Promise<Ticket | null> {
  const rows = await selectTickets(db, viewer, {
    where: sql`t.id = ${id}`,
    limit: 1,
    unscoped: opts.unscoped ?? false,
  });
  return rows[0]?.ticket ?? null;
}
