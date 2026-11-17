import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  statusAfterMessage,
  type CreateMessage,
  type CreateMessageResponse,
} from '@helpdesk/shared';
import type { AuthUser } from '../auth/auth.types.js';
import { Clock } from '../common/clock.js';
import {
  ApiError,
  badRequest,
  forbidden,
  invalidTransition,
  notFound,
  ticketClosed,
} from '../common/errors.js';
import { DB, type Db } from '../db/db.js';
import { messages, ticketReads, tickets } from '../db/schema.js';
import { insertNotifications } from '../notifications/notify.js';
import { RealtimeService, type RealtimeSignal } from '../realtime/realtime.service.js';
import { ticketScope } from './ticket-access.js';
import { bindAttachments, selectMessages } from './ticket-detail.js';
import { TicketMutations } from './ticket-mutations.js';
import { selectTicketById } from './ticket-query.js';
import { TicketsService } from './tickets.service.js';

/** Thrown inside the transaction when a concurrent duplicate already inserted the message. */
class DuplicateMessage extends Error {}

@Injectable()
export class MessagesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly clock: Clock,
    private readonly mutations: TicketMutations,
    private readonly tickets: TicketsService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * Idempotent on (author, clientMessageId): a retry returns the original message with the
   * same status code and body, and repeats none of the side effects (status change,
   * notifications, realtime events).
   */
  async create(
    user: AuthUser,
    ticketId: string,
    input: CreateMessage,
  ): Promise<CreateMessageResponse> {
    const replay = await this.replay(user, ticketId, input.clientMessageId);
    if (replay) return replay;

    let result: {
      messageId: string;
      ticketId: string;
      newTicketId: string | null;
      signals: RealtimeSignal[];
    };
    try {
      result = await this.db.transaction(async (tx) => {
        const current = await this.mutations.lockForUpdate(tx, ticketId, ticketScope(user));
        if (!current) throw notFound('Ticket not found');
        // A concurrent duplicate may have committed while we waited for the row lock.
        const [dup] = await tx
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.authorId, user.id),
              eq(messages.clientMessageId, input.clientMessageId),
            ),
          );
        if (dup) throw new DuplicateMessage();

        const outcome = statusAfterMessage({
          current: current.status,
          role: user.role,
          internal: input.internal,
          followUp: input.followUp,
        });
        if (outcome.kind === 'reject') {
          if (outcome.reason === 'forbidden') throw forbidden('Not allowed for this role');
          if (outcome.reason === 'ticket_closed') throw ticketClosed();
          throw invalidTransition(`Cannot ${input.followUp ?? 'reply'} from ${current.status}`);
        }

        if (outcome.kind === 'spawn') {
          // Closed tickets are never reopened: the reply starts a new ticket linked to the old one.
          const created = await this.tickets.createInTx(
            tx,
            user,
            {
              subject: current.subject,
              category: current.category,
              priority: current.priority,
              body: input.body,
              attachmentIds: input.attachmentIds,
            },
            current.id,
            input.clientMessageId,
          );
          return {
            messageId: created.messageId,
            ticketId: created.ticketId,
            newTicketId: created.ticketId,
            signals: created.signals,
          };
        }

        const now = this.clock.now();
        const inserted = await tx
          .insert(messages)
          .values({
            ticketId,
            authorId: user.id,
            body: input.body,
            internal: input.internal,
            clientMessageId: input.clientMessageId,
            createdAt: now,
          })
          .onConflictDoNothing({ target: [messages.authorId, messages.clientMessageId] })
          .returning({ id: messages.id });
        const message = inserted[0];
        if (!message) throw new DuplicateMessage();
        await bindAttachments(tx, input.attachmentIds, user.id, message.id);

        const signals: RealtimeSignal[] = [
          { type: 'message.created', ticketId, messageId: message.id },
        ];
        const isStaffPublic = user.role !== 'customer' && !input.internal;
        const firstResponse = isStaffPublic && current.firstRespondedAt === null;
        const extra: Partial<typeof tickets.$inferInsert> = {};
        if (firstResponse) {
          extra.firstRespondedAt = now;
          if (current.firstResponseDueAt && now > current.firstResponseDueAt) {
            extra.slaBreachedFirst = true;
          }
        }
        if (outcome.kind === 'set' || firstResponse) {
          const r = await this.mutations.apply(
            tx,
            current,
            outcome.kind === 'set' ? { status: outcome.to } : {},
            {
              actor: user,
              now,
              trigger: outcome.kind === 'set' ? outcome.trigger : 'staff_public_reply',
              extra,
            },
          );
          signals.push(...r.signals);
        }

        // Activity timestamps do not bump the optimistic-lock version: they are not editable fields.
        if (!input.internal) {
          await tx
            .update(tickets)
            .set(
              user.role === 'customer'
                ? { lastMessageAt: now, lastCustomerMessageAt: now, updatedAt: now }
                : { lastMessageAt: now, lastStaffReplyAt: now, updatedAt: now },
            )
            .where(eq(tickets.id, ticketId));
          if (!signals.some((s) => s.type === 'ticket.updated')) {
            signals.push({ type: 'ticket.updated', ticketId });
          }
        }
        if (user.role === 'customer' && current.assigneeId) {
          signals.push(
            ...(await insertNotifications(tx, [
              { userId: current.assigneeId, kind: 'customer_replied', ticketId, at: now },
            ])),
          );
        }
        await tx
          .insert(ticketReads)
          .values({ userId: user.id, ticketId, lastReadAt: now })
          .onConflictDoUpdate({
            target: [ticketReads.userId, ticketReads.ticketId],
            set: { lastReadAt: now },
          });
        return { messageId: message.id, ticketId, newTicketId: null, signals };
      });
    } catch (err) {
      if (err instanceof DuplicateMessage) {
        const again = await this.replay(user, ticketId, input.clientMessageId);
        if (again) return again;
      }
      throw err;
    }

    await this.realtime.emit(...result.signals);
    return this.response(user, result.ticketId, result.messageId, result.newTicketId);
  }

  private async replay(
    user: AuthUser,
    requestedTicketId: string,
    clientMessageId: string,
  ): Promise<CreateMessageResponse | null> {
    const [existing] = await this.db
      .select({ id: messages.id, ticketId: messages.ticketId, parent: tickets.parentTicketId })
      .from(messages)
      .innerJoin(tickets, eq(tickets.id, messages.ticketId))
      .where(and(eq(messages.authorId, user.id), eq(messages.clientMessageId, clientMessageId)));
    if (!existing) return null;
    if (existing.ticketId !== requestedTicketId && existing.parent !== requestedTicketId) {
      throw badRequest('clientMessageId was already used for another ticket');
    }
    const newTicketId = existing.ticketId !== requestedTicketId ? existing.ticketId : null;
    return this.response(user, existing.ticketId, existing.id, newTicketId);
  }

  private async response(
    user: AuthUser,
    ticketId: string,
    messageId: string,
    newTicketId: string | null,
  ): Promise<CreateMessageResponse> {
    const [ticket, msgs] = await Promise.all([
      selectTicketById(this.db, user, ticketId),
      selectMessages(this.db, user, sql`m.id = ${messageId}`),
    ]);
    const message = msgs[0];
    if (!ticket || !message) throw new ApiError(404, 'not_found', 'Message not found');
    return { message, ticket, newTicketId };
  }
}
