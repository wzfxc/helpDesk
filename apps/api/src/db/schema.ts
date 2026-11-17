import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  Category,
  NotificationKind,
  Priority,
  Role,
  SlaKind,
  Status,
  EventField,
  AllowedMimeType,
} from '@helpdesk/shared';

const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
});

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** Used as sort key for tickets without a running SLA deadline (keeps the column NOT NULL). */
export const FAR_FUTURE = new Date('9999-12-31T00:00:00.000Z');

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    role: text('role').$type<Role>().notNull(),
    categories: text('categories')
      .array()
      .$type<Category[]>()
      .notNull()
      .default(sql`'{}'`),
    passwordHash: text('password_hash').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_uq').on(t.email),
    index('users_role_idx').on(t.role),
    check('users_role_ck', sql`${t.role} in ('customer', 'agent', 'lead')`),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    /** sha256 of the cookie token; the raw token is never stored. */
    tokenHash: text('token_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: tstz('created_at').notNull().defaultNow(),
    expiresAt: tstz('expires_at').notNull(),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    email: text('email').notNull(),
    ip: text('ip').notNull(),
    attemptedAt: tstz('attempted_at').notNull().defaultNow(),
  },
  (t) => [
    index('login_attempts_email_idx').on(t.email, t.attemptedAt),
    index('login_attempts_ip_idx').on(t.ip, t.attemptedAt),
  ],
);

/** Single-row counter for gap-free ticket numbers (see README). */
export const ticketCounter = pgTable(
  'ticket_counter',
  {
    id: smallint('id').primaryKey().default(1),
    value: integer('value').notNull().default(0),
  },
  (t) => [check('ticket_counter_single_row_ck', sql`${t.id} = 1`)],
);

export const tickets = pgTable(
  'tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    number: integer('number').notNull(),
    subject: text('subject').notNull(),
    category: text('category').$type<Category>().notNull(),
    priority: text('priority').$type<Priority>().notNull(),
    priorityRank: smallint('priority_rank').generatedAlwaysAs(
      sql`case priority when 'urgent' then 3 when 'high' then 2 when 'normal' then 1 else 0 end`,
    ),
    status: text('status').$type<Status>().notNull().default('new'),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => users.id),
    assigneeId: uuid('assignee_id').references(() => users.id),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'`),
    version: integer('version').notNull().default(0),
    parentTicketId: uuid('parent_ticket_id').references((): AnyPgColumn => tickets.id),
    firstResponseDueAt: tstz('first_response_due_at'),
    resolutionDueAt: tstz('resolution_due_at'),
    firstRespondedAt: tstz('first_responded_at'),
    resolvedAt: tstz('resolved_at'),
    closedAt: tstz('closed_at'),
    /** Nearest running deadline; null when timers are paused or finished. */
    nextDueAt: tstz('next_due_at'),
    /** coalesce(next_due_at, FAR_FUTURE) вЂ” NOT NULL sort key for keyset pagination. */
    slaSortAt: tstz('sla_sort_at').notNull(),
    slaPausedAt: tstz('sla_paused_at'),
    slaBreachedFirst: boolean('sla_breached_first').notNull().default(false),
    slaBreachedResolution: boolean('sla_breached_resolution').notNull().default(false),
    lastMessageAt: tstz('last_message_at').notNull().defaultNow(),
    lastCustomerMessageAt: tstz('last_customer_message_at'),
    lastStaffReplyAt: tstz('last_staff_reply_at'),
    ratingScore: smallint('rating_score'),
    ratingComment: text('rating_comment'),
    ratedAt: tstz('rated_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
    searchVector: tsvector('search_vector')
      .notNull()
      .generatedAlwaysAs(sql`to_tsvector('simple', subject)`),
  },
  (t) => [
    uniqueIndex('tickets_number_uq').on(t.number),
    index('tickets_search_gin').using('gin', t.searchVector),
    index('tickets_tags_gin').using('gin', t.tags),
    index('tickets_sla_sort_idx').on(t.slaSortAt, t.id),
    index('tickets_created_idx').on(t.createdAt, t.id),
    index('tickets_updated_idx').on(t.updatedAt, t.id),
    index('tickets_status_sla_idx').on(t.status, t.slaSortAt, t.id),
    index('tickets_status_created_idx').on(t.status, t.createdAt, t.id),
    index('tickets_assignee_status_sla_idx').on(t.assigneeId, t.status, t.slaSortAt, t.id),
    index('tickets_category_status_sla_idx').on(t.category, t.status, t.slaSortAt, t.id),
    index('tickets_category_created_idx').on(t.category, t.createdAt, t.id),
    index('tickets_category_updated_idx').on(t.category, t.updatedAt, t.id),
    index('tickets_customer_updated_idx').on(t.customerId, t.updatedAt, t.id),
    index('tickets_customer_created_idx').on(t.customerId, t.createdAt, t.id),
    index('tickets_parent_idx').on(t.parentTicketId),
    // "Take next": free tickets per category ordered by urgency.
    index('tickets_queue_free_idx')
      .on(t.category, t.slaSortAt, t.priorityRank, t.createdAt)
      .where(sql`assignee_id is null and status in ('new', 'open')`),
    index('tickets_breached_idx')
      .on(t.slaSortAt, t.id)
      .where(sql`sla_breached_first or sla_breached_resolution`),
    // SLA scan job
    index('tickets_next_due_idx')
      .on(t.nextDueAt)
      .where(sql`next_due_at is not null`),
    // Auto-close job
    index('tickets_resolved_at_idx')
      .on(t.resolvedAt)
      .where(sql`status = 'resolved'`),
    // /stats: tickets resolved per assignee in a period (any status, incl. closed)
    index('tickets_assignee_resolved_idx')
      .on(t.assigneeId, t.resolvedAt)
      .where(sql`resolved_at is not null`),
    check(
      'tickets_status_ck',
      sql`${t.status} in ('new', 'open', 'pending', 'resolved', 'closed')`,
    ),
    check('tickets_priority_ck', sql`${t.priority} in ('low', 'normal', 'high', 'urgent')`),
    check(
      'tickets_category_ck',
      sql`${t.category} in ('billing', 'delivery', 'account', 'technical', 'other')`,
    ),
    check('tickets_rating_ck', sql`${t.ratingScore} is null or ${t.ratingScore} between 1 and 5`),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    body: text('body').notNull(),
    internal: boolean('internal').notNull().default(false),
    clientMessageId: uuid('client_message_id'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    searchVector: tsvector('search_vector')
      .notNull()
      .generatedAlwaysAs(sql`to_tsvector('simple', body)`),
  },
  (t) => [
    index('messages_ticket_created_idx').on(t.ticketId, t.createdAt),
    // Idempotency key. Scoped by author (not ticket) so a retried reply to a closed ticket,
    // which lands in the newly spawned ticket, is still recognised.
    uniqueIndex('messages_author_client_id_uq').on(t.authorId, t.clientMessageId),
    index('messages_search_gin').using('gin', t.searchVector),
    index('messages_public_search_gin')
      .using('gin', t.searchVector)
      .where(sql`not internal`),
    index('messages_author_created_idx').on(t.authorId, t.createdAt),
    // /stats: public replies per agent in a period
    index('messages_staff_reply_idx')
      .on(t.authorId, t.createdAt)
      .where(sql`not internal`),
  ],
);

export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    uploaderId: uuid('uploader_id')
      .notNull()
      .references(() => users.id),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').$type<AllowedMimeType>().notNull(),
    size: integer('size').notNull(),
    /** File name on disk (uuid); the original name is only kept in `filename`. */
    storageKey: text('storage_key').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('attachments_message_idx').on(t.messageId),
    index('attachments_orphan_idx')
      .on(t.createdAt)
      .where(sql`message_id is null`),
  ],
);

export const ticketEvents = pgTable(
  'ticket_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    /** null = system (background job). */
    actorId: uuid('actor_id').references(() => users.id),
    field: text('field').$type<EventField>().notNull(),
    fromValue: text('from_value'),
    toValue: text('to_value'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('ticket_events_ticket_idx').on(t.ticketId, t.createdAt),
    index('ticket_events_field_idx').on(t.field, t.toValue, t.createdAt),
  ],
);

export const ticketReads = pgTable(
  'ticket_reads',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    lastReadAt: tstz('last_read_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.ticketId] })],
);

export const slaPolicies = pgTable('sla_policies', {
  priority: text('priority').$type<Priority>().primaryKey(),
  firstResponseMinutes: integer('first_response_minutes').notNull(),
  resolutionMinutes: integer('resolution_minutes').notNull(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => users.id),
});

/** Intervals during which SLA timers were stopped (status pending or resolved). */
export const slaPauses = pgTable(
  'sla_pauses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    startedAt: tstz('started_at').notNull(),
    endedAt: tstz('ended_at'),
  },
  (t) => [
    index('sla_pauses_ticket_idx').on(t.ticketId, t.startedAt),
    uniqueIndex('sla_pauses_open_uq')
      .on(t.ticketId)
      .where(sql`ended_at is null`),
  ],
);

/** Dedupe ledger for SLA warnings/breaches: one row per (ticket, kind, deadline). */
export const slaAlerts = pgTable(
  'sla_alerts',
  {
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    alert: text('alert').$type<'warning' | 'breach'>().notNull(),
    slaKind: text('sla_kind').$type<SlaKind>().notNull(),
    dueAt: tstz('due_at').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.ticketId, t.alert, t.slaKind, t.dueAt] })],
);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<NotificationKind>().notNull(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    dueAt: tstz('due_at'),
    readAt: tstz('read_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('notifications_user_created_idx').on(t.userId, t.createdAt),
    index('notifications_user_unread_idx')
      .on(t.userId)
      .where(sql`read_at is null`),
  ],
);

export const cannedResponses = pgTable('canned_responses', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  category: text('category').$type<Category>(),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const savedViews = pgTable(
  'saved_views',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    query: text('query').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [index('saved_views_user_idx').on(t.userId, t.createdAt)],
);

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export const jobs = pgTable(
  'jobs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').$type<JobStatus>().notNull().default('queued'),
    runAt: tstz('run_at').notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    lockedUntil: tstz('locked_until'),
    lockedBy: text('locked_by'),
    lastError: text('last_error'),
    /** e.g. `sla-scan:2025-01-01T10:05` вЂ” makes scheduling idempotent across restarts. */
    dedupeKey: text('dedupe_key'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    finishedAt: tstz('finished_at'),
  },
  (t) => [
    uniqueIndex('jobs_dedupe_uq').on(t.dedupeKey),
    index('jobs_ready_idx')
      .on(t.runAt)
      .where(sql`status in ('queued', 'running')`),
    index('jobs_finished_idx')
      .on(t.finishedAt)
      .where(sql`status in ('done', 'failed')`),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type TicketRow = typeof tickets.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type AttachmentRow = typeof attachments.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
