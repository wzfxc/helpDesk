import { sql } from 'drizzle-orm';
import type {
  AllowedMimeType,
  Attachment,
  EventField,
  Message,
  Role,
  TicketEvent,
} from '@helpdesk/shared';
import type { AuthUser } from '../auth/auth.types.js';
import { ApiError } from '../common/errors.js';
import type { DbOrTx } from '../db/db.js';
import { messageVisibility, toUuidArray } from './ticket-access.js';

interface MessageRowDb {
  id: string;
  ticket_id: string;
  author_id: string;
  author_name: string;
  author_role: Role;
  body: string;
  internal: boolean;
  client_message_id: string | null;
  created_at: Date;
}

interface AttachmentRowDb {
  id: string;
  message_id: string;
  filename: string;
  mime_type: AllowedMimeType;
  size: number;
}

/** Messages visible to `viewer` (internal notes filtered in SQL for customers), with attachments. */
export async function selectMessages(
  db: DbOrTx,
  viewer: AuthUser,
  where: ReturnType<typeof sql>,
): Promise<Message[]> {
  const res = await db.execute<MessageRowDb & Record<string, unknown>>(sql`
    select m.id, m.ticket_id, m.author_id, u.name as author_name, u.role as author_role,
           m.body, m.internal, m.client_message_id, m.created_at
    from messages m
    join users u on u.id = m.author_id
    where ${where} and ${messageVisibility(viewer)}
    order by m.created_at, m.id`);
  const rows = res.rows;
  if (rows.length === 0) return [];
  const att = await db.execute<AttachmentRowDb & Record<string, unknown>>(sql`
    select a.id, a.message_id, a.filename, a.mime_type, a.size
    from attachments a
    where a.message_id = any(${toUuidArray(rows.map((r) => r.id))})
    order by a.created_at, a.id`);
  const byMessage = new Map<string, Attachment[]>();
  for (const a of att.rows) {
    const list = byMessage.get(a.message_id) ?? [];
    list.push({ id: a.id, filename: a.filename, mimeType: a.mime_type, size: a.size });
    byMessage.set(a.message_id, list);
  }
  return rows.map((r) => ({
    id: r.id,
    ticketId: r.ticket_id,
    author: { id: r.author_id, name: r.author_name, role: r.author_role },
    body: r.body,
    internal: r.internal,
    clientMessageId: r.client_message_id,
    attachments: byMessage.get(r.id) ?? [],
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

interface EventRowDb {
  id: string;
  ticket_id: string;
  actor_id: string | null;
  actor_name: string | null;
  field: EventField;
  from_value: string | null;
  to_value: string | null;
  created_at: Date;
}

export async function selectEvents(db: DbOrTx, ticketId: string): Promise<TicketEvent[]> {
  const res = await db.execute<EventRowDb & Record<string, unknown>>(sql`
    select e.id, e.ticket_id, e.actor_id, u.name as actor_name, e.field, e.from_value, e.to_value, e.created_at
    from ticket_events e
    left join users u on u.id = e.actor_id
    where e.ticket_id = ${ticketId}
    order by e.created_at, e.id`);
  return res.rows.map((r) => ({
    id: r.id,
    ticketId: r.ticket_id,
    actor: r.actor_id ? { id: r.actor_id, name: r.actor_name ?? '' } : null,
    field: r.field,
    from: r.from_value,
    to: r.to_value,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

/**
 * Binds uploaded attachments to a message. Only the uploader's own, still unbound
 * attachments qualify; the conditional UPDATE makes double-binding impossible.
 */
export async function bindAttachments(
  db: DbOrTx,
  ids: readonly string[],
  uploaderId: string,
  messageId: string,
): Promise<void> {
  if (ids.length === 0) return;
  const res = await db.execute(sql`
    update attachments set message_id = ${messageId}
    where id = any(${toUuidArray(ids)}) and uploader_id = ${uploaderId} and message_id is null
    returning id`);
  if (res.rows.length !== ids.length) {
    throw new ApiError(
      422,
      'attachment_unavailable',
      'Some attachments do not exist, belong to someone else or are already used',
    );
  }
}
