import { z } from 'zod';
import { IdSchema, UserRefSchema } from './schemas/common';
import { NotificationSchema } from './schemas/misc';
import { MessageSchema, TicketSchema } from './schemas/tickets';

/** Server-sent events delivered on GET /events. */
export const ServerEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message.created'), ticketId: IdSchema, message: MessageSchema }),
  z.object({ type: z.literal('ticket.created'), ticket: TicketSchema }),
  z.object({ type: z.literal('ticket.updated'), ticket: TicketSchema }),
  z.object({ type: z.literal('notification.created'), notification: NotificationSchema }),
  z.object({ type: z.literal('typing'), ticketId: IdSchema, user: UserRefSchema }),
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;
export type ServerEventType = ServerEvent['type'];

/** How long the web shows "X is replying" after the last typing ping. */
export const TYPING_TTL_MS = 6_000;
/** Minimum interval between typing pings sent by the web. */
export const TYPING_THROTTLE_MS = 2_500;
export const SSE_HEARTBEAT_MS = 20_000;
