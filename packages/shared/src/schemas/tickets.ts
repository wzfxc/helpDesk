import { z } from 'zod';
import {
  CategorySchema,
  CustomerPrioritySchema,
  EventFieldSchema,
  PrioritySchema,
  RoleSchema,
  StatusSchema,
} from '../enums';
import { LIMITS } from '../limits';
import { AttachmentSchema } from './attachments';
import {
  IdSchema,
  IsoDateTimeSchema,
  TagSchema,
  TagsSchema,
  UserRefSchema,
  queryBoolean,
  queryList,
  text,
} from './common';

const AttachmentIdsSchema = z
  .array(IdSchema)
  .max(LIMITS.attachmentsPerMessage)
  .refine((ids) => new Set(ids).size === ids.length, 'Duplicate attachment ids')
  .default([]);

/** POST /tickets — only customers create tickets. */
export const CreateTicketSchema = z.object({
  subject: text(LIMITS.subjectMax),
  category: CategorySchema,
  priority: CustomerPrioritySchema,
  body: text(LIMITS.messageBodyMax),
  attachmentIds: AttachmentIdsSchema,
});
export type CreateTicketInput = z.input<typeof CreateTicketSchema>;
export type CreateTicket = z.output<typeof CreateTicketSchema>;

/** PATCH /tickets/:id — staff only, optimistic locking via `version`. */
export const UpdateTicketSchema = z
  .object({
    version: z.number().int().nonnegative(),
    status: StatusSchema.optional(),
    priority: PrioritySchema.optional(),
    category: CategorySchema.optional(),
    assigneeId: IdSchema.nullable().optional(),
    tags: TagsSchema.optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.status !== undefined ||
      v.priority !== undefined ||
      v.category !== undefined ||
      v.assigneeId !== undefined ||
      v.tags !== undefined,
    { message: 'Nothing to update' },
  );
export type UpdateTicket = z.infer<typeof UpdateTicketSchema>;

export const RatingInputSchema = z.object({
  score: z.number().int().min(1).max(5),
  comment: z.string().trim().max(LIMITS.ratingCommentMax).optional(),
});
export type RatingInput = z.infer<typeof RatingInputSchema>;

export const RatingSchema = z.object({
  score: z.number().int(),
  comment: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
});

export const TicketSchema = z.object({
  id: IdSchema,
  number: z.number().int(),
  subject: z.string(),
  category: CategorySchema,
  priority: PrioritySchema,
  status: StatusSchema,
  tags: z.array(z.string()),
  version: z.number().int(),
  customer: UserRefSchema.extend({ email: z.string() }),
  assignee: UserRefSchema.nullable(),
  parentTicketId: IdSchema.nullable(),
  parentTicketNumber: z.number().int().nullable(),
  firstResponseDueAt: IsoDateTimeSchema.nullable(),
  resolutionDueAt: IsoDateTimeSchema.nullable(),
  firstRespondedAt: IsoDateTimeSchema.nullable(),
  resolvedAt: IsoDateTimeSchema.nullable(),
  closedAt: IsoDateTimeSchema.nullable(),
  /** Nearest running SLA deadline; null when paused (pending) or finished. */
  nextDueAt: IsoDateTimeSchema.nullable(),
  slaPaused: z.boolean(),
  slaBreachedFirst: z.boolean(),
  slaBreachedResolution: z.boolean(),
  lastMessageAt: IsoDateTimeSchema,
  unread: z.boolean(),
  rating: RatingSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Ticket = z.infer<typeof TicketSchema>;

export const MessageSchema = z.object({
  id: IdSchema,
  ticketId: IdSchema,
  author: UserRefSchema.extend({ role: RoleSchema }),
  body: z.string(),
  internal: z.boolean(),
  clientMessageId: IdSchema.nullable(),
  attachments: z.array(AttachmentSchema),
  createdAt: IsoDateTimeSchema,
});
export type Message = z.infer<typeof MessageSchema>;

export const TicketEventSchema = z.object({
  id: IdSchema,
  ticketId: IdSchema,
  actor: UserRefSchema.nullable(),
  field: EventFieldSchema,
  from: z.string().nullable(),
  to: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
});
export type TicketEvent = z.infer<typeof TicketEventSchema>;

export const TicketDetailSchema = z.object({
  ticket: TicketSchema,
  messages: z.array(MessageSchema),
  /** Field-change history; empty for customers. */
  events: z.array(TicketEventSchema),
});
export type TicketDetail = z.infer<typeof TicketDetailSchema>;

export const FOLLOW_UPS = ['pending', 'resolved'] as const;

/** POST /tickets/:id/messages */
export const CreateMessageSchema = z.object({
  clientMessageId: IdSchema,
  body: text(LIMITS.messageBodyMax),
  internal: z.boolean().default(false),
  attachmentIds: AttachmentIdsSchema,
  /** Staff only: "send and wait for customer" / "send and resolve". */
  followUp: z.enum(FOLLOW_UPS).optional(),
});
export type CreateMessageInput = z.input<typeof CreateMessageSchema>;
export type CreateMessage = z.output<typeof CreateMessageSchema>;

export const CreateMessageResponseSchema = z.object({
  message: MessageSchema,
  ticket: TicketSchema,
  /** Set when a customer replied to a closed ticket and a new one was created. */
  newTicketId: IdSchema.nullable(),
});
export type CreateMessageResponse = z.infer<typeof CreateMessageResponseSchema>;

export const VersionConflictSchema = z.object({
  error: z.object({ code: z.literal('version_conflict'), message: z.string() }),
  current: TicketSchema,
});
export type VersionConflict = z.infer<typeof VersionConflictSchema>;

// ---------- List ----------

export const TICKET_SORTS = ['sla', '-sla', 'created', '-created', 'updated', '-updated'] as const;
export const TicketSortSchema = z.enum(TICKET_SORTS);
export type TicketSort = z.infer<typeof TicketSortSchema>;

export const AssigneeFilterSchema = z.union([z.literal('me'), z.literal('none'), IdSchema]);

/** Filters that can be stored in a saved view and mirrored in the URL. */
export const TicketFiltersSchema = z.object({
  status: queryList(StatusSchema),
  priority: queryList(PrioritySchema),
  category: queryList(CategorySchema),
  assignee: AssigneeFilterSchema.optional(),
  slaBreached: queryBoolean.optional(),
  /** Running deadline within LIMITS.slaRiskMinutes (or already overdue). */
  slaRisk: queryBoolean.optional(),
  tags: queryList(TagSchema),
  createdFrom: IsoDateTimeSchema.optional(),
  createdTo: IsoDateTimeSchema.optional(),
  q: z.string().trim().max(LIMITS.searchQueryMax).optional(),
  sort: TicketSortSchema.optional(),
});
export type TicketFilters = z.infer<typeof TicketFiltersSchema>;
export type TicketFiltersInput = z.input<typeof TicketFiltersSchema>;

export const TicketListQuerySchema = TicketFiltersSchema.extend({
  cursor: z.string().max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.pageSizeMax).default(LIMITS.pageSizeDefault),
});
export type TicketListQuery = z.infer<typeof TicketListQuerySchema>;
export type TicketListQueryInput = z.input<typeof TicketListQuerySchema>;

export const TicketListResponseSchema = z.object({
  items: z.array(TicketSchema),
  nextCursor: z.string().nullable(),
});
export type TicketListResponse = z.infer<typeof TicketListResponseSchema>;

// ---------- Bulk ----------

export const BulkActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('assign'), assigneeId: IdSchema.nullable() }),
  z.object({ type: z.literal('status'), status: StatusSchema }),
  z.object({ type: z.literal('priority'), priority: PrioritySchema }),
  z
    .object({
      type: z.literal('tags'),
      add: TagsSchema.default([]),
      remove: TagsSchema.default([]),
    })
    .refine((v) => v.add.length + v.remove.length > 0, { message: 'Nothing to change' }),
]);
export type BulkAction = z.infer<typeof BulkActionSchema>;

export const BulkRequestSchema = z.object({
  ids: z
    .array(IdSchema)
    .min(1)
    .max(LIMITS.bulkMax)
    .refine((ids) => new Set(ids).size === ids.length, 'Duplicate ids'),
  action: BulkActionSchema,
});
export type BulkRequest = z.infer<typeof BulkRequestSchema>;

export const BULK_SKIP_REASONS = [
  'not_found',
  'forbidden',
  'invalid_transition',
  'invalid_assignee',
  'ticket_closed',
] as const;
export const BulkSkipReasonSchema = z.enum(BULK_SKIP_REASONS);
export type BulkSkipReason = z.infer<typeof BulkSkipReasonSchema>;

export const BulkResultSchema = z.discriminatedUnion('ok', [
  z.object({ id: IdSchema, ok: z.literal(true) }),
  z.object({ id: IdSchema, ok: z.literal(false), reason: BulkSkipReasonSchema }),
]);
export type BulkResult = z.infer<typeof BulkResultSchema>;

export const BulkResponseSchema = z.object({
  results: z.array(BulkResultSchema),
  succeeded: z.number().int(),
  skipped: z.number().int(),
});
export type BulkResponse = z.infer<typeof BulkResponseSchema>;
