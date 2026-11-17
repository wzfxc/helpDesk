import { z } from 'zod';

export const ROLES = ['customer', 'agent', 'lead'] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

export const STAFF_ROLES = ['agent', 'lead'] as const satisfies readonly Role[];
export const isStaff = (role: Role): boolean => role === 'agent' || role === 'lead';

export const STATUSES = ['new', 'open', 'pending', 'resolved', 'closed'] as const;
export const StatusSchema = z.enum(STATUSES);
export type Status = z.infer<typeof StatusSchema>;

/** Statuses in which SLA timers are running. `pending` pauses them. */
export const ACTIVE_SLA_STATUSES = ['new', 'open'] as const satisfies readonly Status[];

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const PrioritySchema = z.enum(PRIORITIES);
export type Priority = z.infer<typeof PrioritySchema>;

/** Customers may only pick from these; `urgent` is reserved for staff. */
export const CUSTOMER_PRIORITIES = ['low', 'normal', 'high'] as const satisfies readonly Priority[];
export const CustomerPrioritySchema = z.enum(CUSTOMER_PRIORITIES);

/** Higher number = more urgent. Used for ordering. */
export const PRIORITY_RANK: Record<Priority, number> = { low: 0, normal: 1, high: 2, urgent: 3 };

export const CATEGORIES = ['billing', 'delivery', 'account', 'technical', 'other'] as const;
export const CategorySchema = z.enum(CATEGORIES);
export type Category = z.infer<typeof CategorySchema>;

export const EVENT_FIELDS = ['status', 'priority', 'assignee', 'category', 'tags'] as const;
export const EventFieldSchema = z.enum(EVENT_FIELDS);
export type EventField = z.infer<typeof EventFieldSchema>;

export const NOTIFICATION_KINDS = [
  'ticket_assigned',
  'customer_replied',
  'sla_warning',
  'sla_breached',
] as const;
export const NotificationKindSchema = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

export const SLA_KINDS = ['first_response', 'resolution'] as const;
export const SlaKindSchema = z.enum(SLA_KINDS);
export type SlaKind = z.infer<typeof SlaKindSchema>;
