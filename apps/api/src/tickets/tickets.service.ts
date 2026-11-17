import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type {
  CreateTicket,
  Priority,
  RatingInput,
  Ticket,
  TicketDetail,
  TicketListQuery,
  TicketListResponse,
  UpdateTicket,
} from '@helpdesk/shared';
import type { AuthUser } from '../auth/auth.types.js';
import { Clock } from '../common/clock.js';
import { ApiError, forbidden, notFound } from '../common/errors.js';
import { DB, type Db, type DbOrTx } from '../db/db.js';
import { messages, ticketReads, tickets } from '../db/schema.js';
import { RealtimeService, type RealtimeSignal } from '../realtime/realtime.service.js';
import { SlaService } from '../sla/sla.service.js';
import { ticketScope } from './ticket-access.js';
import { bindAttachments, selectEvents, selectMessages } from './ticket-detail.js';
import { TicketMutations, VersionConflictError } from './ticket-mutations.js';
import { selectTicketById } from './ticket-query.js';
import { listTickets } from './ticket-list.js';

@Injectable()
export class TicketsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly clock: Clock,
    private readonly sla: SlaService,
    private readonly mutations: TicketMutations,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * Number allocation: `UPDATE ticket_counter … RETURNING` in the same transaction as the
   * insert. The row lock serialises concurrent creators; a rollback also rolls back the
   * increment, so numbers have neither gaps nor duplicates (unlike a sequence).
   */
  async allocateNumber(tx: DbOrTx): Promise<number> {
    const res = await tx.execute<{ value: number }>(
      sql`update ticket_counter set value = value + 1 where id = 1 returning value`,
    );
    const value = res.rows[0]?.value;
    if (value === undefined) throw new Error('ticket_counter row is missing');
    return value;
  }

  async create(
    user: AuthUser,
    input: CreateTicket,
    parentTicketId: string | null = null,
  ): Promise<Ticket> {
    const { ticketId, signals } = await this.db.transaction(async (tx) => {
      const r = await this.createInTx(tx, user, input, parentTicketId);
      return r;
    });
    await this.realtime.emit(...signals);
    const ticket = await selectTicketById(this.db, user, ticketId);
    if (!ticket) throw notFound();
    return ticket;
  }

  /** Also used when a customer replies to a closed ticket. */
  async createInTx(
    tx: DbOrTx,
    user: AuthUser,
    input: Pick<CreateTicket, 'subject' | 'category' | 'body' | 'attachmentIds'> & {
      /** Customers pick low..high; a follow-up of a closed ticket inherits its priority. */
      priority: Priority;
    },
    parentTicketId: string | null,
    clientMessageId: string | null = null,
  ): Promise<{ ticketId: string; messageId: string; signals: RealtimeSignal[] }> {
    if (user.role !== 'customer') throw forbidden('Only customers create tickets');
    const now = this.clock.now();
    const number = await this.allocateNumber(tx);
    const sla = await this.sla.initial(tx, input.priority, now);
    const [ticket] = await tx
      .insert(tickets)
      .values({
        number,
        subject: input.subject,
        category: input.category,
        priority: input.priority,
        status: 'new',
        customerId: user.id,
        parentTicketId,
        ...sla,
        lastMessageAt: now,
        lastCustomerMessageAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: tickets.id });
    if (!ticket) throw new Error('ticket insert failed');
    const [message] = await tx
      .insert(messages)
      .values({
        ticketId: ticket.id,
        authorId: user.id,
        body: input.body,
        internal: false,
        clientMessageId,
        createdAt: now,
      })
      .returning({ id: messages.id });
    if (!message) throw new Error('message insert failed');
    await bindAttachments(tx, input.attachmentIds, user.id, message.id);
    await tx
      .insert(ticketReads)
      .values({ userId: user.id, ticketId: ticket.id, lastReadAt: now })
      .onConflictDoNothing();
    return {
      ticketId: ticket.id,
      messageId: message.id,
      signals: [{ type: 'ticket.created', ticketId: ticket.id }],
    };
  }

  list(user: AuthUser, query: TicketListQuery): Promise<TicketListResponse> {
    return listTickets(this.db, user, query, this.clock.now());
  }

  async detail(user: AuthUser, id: string): Promise<TicketDetail> {
    const ticket = await selectTicketById(this.db, user, id);
    if (!ticket) throw notFound('Ticket not found');
    const [msgs, events] = await Promise.all([
      selectMessages(this.db, user, sql`m.ticket_id = ${id}`),
      user.role === 'customer' ? Promise.resolve([]) : selectEvents(this.db, id),
    ]);
    return { ticket, messages: msgs, events };
  }

  async update(user: AuthUser, id: string, input: UpdateTicket): Promise<Ticket> {
    let signals: RealtimeSignal[] = [];
    try {
      signals = await this.db.transaction(async (tx) => {
        const current = await this.mutations.lockForUpdate(tx, id, ticketScope(user));
        if (!current) throw notFound('Ticket not found');
        const result = await this.mutations.apply(
          tx,
          current,
          {
            status: input.status,
            priority: input.priority,
            category: input.category,
            assigneeId: input.assigneeId,
            tags: input.tags,
          },
          {
            actor: user,
            now: this.clock.now(),
            trigger: 'staff_manual',
            expectedVersion: input.version,
          },
        );
        return result.signals;
      });
    } catch (err) {
      if (err instanceof VersionConflictError) throw await this.conflict(user, id);
      throw err;
    }
    await this.realtime.emit(...signals);
    const ticket = await selectTicketById(this.db, user, id, { unscoped: true });
    if (!ticket) throw notFound();
    return ticket;
  }

  /** 409 body carries the current state so the client can merge without losing input. */
  async conflict(user: AuthUser, id: string): Promise<ApiError> {
    const current = await selectTicketById(this.db, user, id, { unscoped: true });
    return new ApiError(
      409,
      'version_conflict',
      'The ticket was changed by someone else',
      undefined,
      { current },
    );
  }

  /** "Problem solved" by the customer. */
  async resolveByCustomer(user: AuthUser, id: string): Promise<Ticket> {
    const signals = await this.db.transaction(async (tx) => {
      const current = await this.mutations.lockForUpdate(tx, id, ticketScope(user));
      if (!current) throw notFound('Ticket not found');
      if (current.status === 'resolved') return [];
      const r = await this.mutations.apply(
        tx,
        current,
        { status: 'resolved' },
        { actor: user, now: this.clock.now(), trigger: 'customer_resolve' },
      );
      return r.signals;
    });
    await this.realtime.emit(...signals);
    const ticket = await selectTicketById(this.db, user, id);
    if (!ticket) throw notFound();
    return ticket;
  }

  async rate(user: AuthUser, id: string, input: RatingInput): Promise<Ticket> {
    const now = this.clock.now();
    const updated = await this.db.execute(sql`
      update tickets t set rating_score = ${input.score}, rating_comment = ${input.comment ?? null},
        rated_at = ${now}, updated_at = ${now}, version = t.version + 1
      where t.id = ${id} and ${ticketScope(user)} and t.status in ('resolved', 'closed')
      returning t.id`);
    if (updated.rows.length === 0) {
      const visible = await selectTicketById(this.db, user, id);
      if (!visible) throw notFound('Ticket not found');
      throw new ApiError(422, 'invalid_transition', 'Only resolved or closed tickets can be rated');
    }
    await this.realtime.emit({ type: 'ticket.updated', ticketId: id });
    const ticket = await selectTicketById(this.db, user, id);
    if (!ticket) throw notFound();
    return ticket;
  }
  async markRead(user: AuthUser, id: string): Promise<void> {
    const ticket = await selectTicketById(this.db, user, id);
    if (!ticket) throw notFound('Ticket not found');
    const now = this.clock.now();
    await this.db
      .insert(ticketReads)
      .values({ userId: user.id, ticketId: id, lastReadAt: now })
      .onConflictDoUpdate({
        target: [ticketReads.userId, ticketReads.ticketId],
        set: { lastReadAt: now },
      });
  }

  async exists(id: string): Promise<boolean> {
    const [row] = await this.db.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, id));
    return !!row;
  }
}
