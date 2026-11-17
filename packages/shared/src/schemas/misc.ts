import { z } from 'zod';
import { CategorySchema, NotificationKindSchema, PrioritySchema } from '../enums';
import { LIMITS } from '../limits';
import { IdSchema, IsoDateTimeSchema, safeString, text } from './common';
import { TicketFiltersSchema } from './tickets';

// ---------- Notifications ----------

export const NotificationSchema = z.object({
  id: IdSchema,
  kind: NotificationKindSchema,
  ticketId: IdSchema,
  ticketNumber: z.number().int(),
  ticketSubject: z.string(),
  /** SLA deadline for sla_* kinds. */
  dueAt: IsoDateTimeSchema.nullable(),
  readAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type Notification = z.infer<typeof NotificationSchema>;

export const NotificationListSchema = z.object({
  items: z.array(NotificationSchema),
  unreadCount: z.number().int(),
});
export type NotificationList = z.infer<typeof NotificationListSchema>;

export const MarkNotificationsReadSchema = z.union([
  z.object({ ids: z.array(IdSchema).min(1).max(500) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);
export type MarkNotificationsRead = z.infer<typeof MarkNotificationsReadSchema>;

// ---------- Canned responses ----------

export const CannedResponseSchema = z.object({
  id: IdSchema,
  title: z.string(),
  body: z.string(),
  category: CategorySchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type CannedResponse = z.infer<typeof CannedResponseSchema>;

export const UpsertCannedResponseSchema = z.object({
  title: text(LIMITS.cannedTitleMax),
  body: text(LIMITS.cannedBodyMax),
  category: CategorySchema.nullable().default(null),
});
export type UpsertCannedResponse = z.infer<typeof UpsertCannedResponseSchema>;

/** Placeholders supported in canned responses. */
export const CANNED_PLACEHOLDERS = ['customerName', 'ticketNumber', 'agentName'] as const;
export type CannedPlaceholder = (typeof CANNED_PLACEHOLDERS)[number];

export function renderCannedResponse(
  body: string,
  values: Partial<Record<CannedPlaceholder, string>>,
): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
    const value = (values as Record<string, string | undefined>)[key];
    return value ?? match;
  });
}

// ---------- Saved views ----------

export const SavedViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  builtIn: z.boolean(),
  /** URL query string with filters, e.g. `status=open&assignee=me`. */
  query: z.string(),
});
export type SavedView = z.infer<typeof SavedViewSchema>;

export const CreateSavedViewSchema = z.object({
  name: text(LIMITS.viewNameMax),
  query: safeString()
    .pipe(z.string().max(LIMITS.savedViewQueryMax))
    .refine((q) => {
      const params = new URLSearchParams(q);
      const obj: Record<string, string> = {};
      params.forEach((v, k) => {
        obj[k] = v;
      });
      return TicketFiltersSchema.safeParse(obj).success;
    }, 'Invalid filters'),
});
export type CreateSavedView = z.infer<typeof CreateSavedViewSchema>;

export const BUILT_IN_VIEWS = [
  { id: 'builtin:my-open', key: 'myOpen', query: 'assignee=me&status=new,open,pending&sort=sla' },
  { id: 'builtin:unassigned', key: 'unassigned', query: 'assignee=none&status=new,open&sort=sla' },
  { id: 'builtin:sla-hot', key: 'slaHot', query: 'slaRisk=true&sort=sla' },
] as const;

// ---------- SLA policies ----------

export const SlaPolicySchema = z.object({
  priority: PrioritySchema,
  firstResponseMinutes: z
    .number()
    .int()
    .min(1)
    .max(60 * 24 * 30),
  resolutionMinutes: z
    .number()
    .int()
    .min(1)
    .max(60 * 24 * 90),
});
export type SlaPolicy = z.infer<typeof SlaPolicySchema>;

export const UpdateSlaPoliciesSchema = z
  .object({ policies: z.array(SlaPolicySchema).min(1).max(4) })
  .refine(
    (v) => new Set(v.policies.map((p) => p.priority)).size === v.policies.length,
    'Duplicate priority',
  )
  .refine(
    (v) => v.policies.every((p) => p.resolutionMinutes >= p.firstResponseMinutes),
    'Resolution time must be >= first response time',
  );
export type UpdateSlaPolicies = z.infer<typeof UpdateSlaPoliciesSchema>;

/** Defaults from the assignment (business minutes; 1 business day = 9h). */
export const DEFAULT_SLA_POLICIES: readonly SlaPolicy[] = [
  { priority: 'urgent', firstResponseMinutes: 60, resolutionMinutes: 4 * 60 },
  { priority: 'high', firstResponseMinutes: 4 * 60, resolutionMinutes: LIMITS.businessDayMinutes },
  {
    priority: 'normal',
    firstResponseMinutes: LIMITS.businessDayMinutes,
    resolutionMinutes: 3 * LIMITS.businessDayMinutes,
  },
  {
    priority: 'low',
    firstResponseMinutes: 2 * LIMITS.businessDayMinutes,
    resolutionMinutes: 5 * LIMITS.businessDayMinutes,
  },
];

// ---------- Stats ----------

export const StatsQuerySchema = z
  .object({
    from: IsoDateTimeSchema,
    to: IsoDateTimeSchema,
  })
  .refine((v) => Date.parse(v.from) <= Date.parse(v.to), 'from must be before to');
export type StatsQuery = z.infer<typeof StatsQuerySchema>;

export const StatsSchema = z.object({
  from: IsoDateTimeSchema,
  to: IsoDateTimeSchema,
  created: z.number().int(),
  resolved: z.number().int(),
  /** Business minutes. */
  avgFirstResponseMinutes: z.number().nullable(),
  avgResolutionMinutes: z.number().nullable(),
  /** 0..1 share of tickets created in the period with any SLA breach. */
  slaBreachRate: z.number().nullable(),
  avgRating: z.number().nullable(),
  ratingsCount: z.number().int(),
  agents: z.array(
    z.object({
      id: IdSchema,
      name: z.string(),
      openAssigned: z.number().int(),
      resolvedInPeriod: z.number().int(),
      repliesInPeriod: z.number().int(),
    }),
  ),
});
export type Stats = z.infer<typeof StatsSchema>;
