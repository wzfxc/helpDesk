import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  canTransition,
  type Category,
  type EventField,
  type Priority,
  type Status,
  type TransitionTrigger,
} from '@helpdesk/shared';
import type { AuthUser } from '../auth/auth.types.js';
import { ApiError, forbidden, invalidTransition, ticketClosed } from '../common/errors.js';
import type { DbOrTx } from '../db/db.js';
import { ticketEvents, tickets, users, type TicketRow } from '../db/schema.js';
import { insertNotifications } from '../notifications/notify.js';
import type { RealtimeSignal } from '../realtime/realtime.service.js';
import { SlaService } from '../sla/sla.service.js';

export interface TicketChanges {
  status?: Status | undefined;
  priority?: Priority | undefined;
  category?: Category | undefined;
  assigneeId?: string | null | undefined;
  tags?: string[] | undefined;
}

export interface MutationContext {
  /** null = system (background job). */
  actor: AuthUser | null;
  now: Date;
  trigger: TransitionTrigger;
  /** Optimistic lock: the version the client saw. */
  expectedVersion?: number | undefined;
  /** Extra columns to set in the same UPDATE (e.g. first_responded_at, last_message_at). */
  extra?: Partial<typeof tickets.$inferInsert>;
}

export interface MutationResult {
  row: TicketRow;
  changed: boolean;
  signals: RealtimeSignal[];
}

export class VersionConflictError extends Error {
  constructor(readonly ticketId: string) {
    super('version conflict');
  }
}

const sameTags = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((t, i) => t === b[i]);

/**
 * The only place that changes ticket fields. Runs inside the caller's transaction on a
 * row the caller has locked (SELECT … FOR UPDATE) and already authorised for reading.
 * Validates transitions/assignment, writes history, keeps SLA fields consistent and bumps
 * the version with `WHERE version = expected` (409 if somebody else won).
 */
@Injectable()
export class TicketMutations {
  constructor(private readonly sla: SlaService) {}

  async lockForUpdate(
    db: DbOrTx,
    id: string,
    scope: ReturnType<typeof sql>,
  ): Promise<TicketRow | null> {
    const res = await db.execute(
      sql`select t.id from tickets t where t.id = ${id} and ${scope} for update`,
    );
    if (res.rows.length === 0) return null;
    const [row] = await db.select().from(tickets).where(eq(tickets.id, id));
    return row ?? null;
  }

  async apply(
    db: DbOrTx,
    current: TicketRow,
    changes: TicketChanges,
    ctx: MutationContext,
  ): Promise<MutationResult> {
    if (ctx.expectedVersion !== undefined && ctx.expectedVersion !== current.version) {
      throw new VersionConflictError(current.id);
    }
    const actorId = ctx.actor?.id ?? null;
    const events: { field: EventField; from: string | null; to: string | null }[] = [];
    const signals: RealtimeSignal[] = [];
    const set: Partial<typeof tickets.$inferInsert> = { ...ctx.extra };

    const status = changes.status ?? current.status;
    const priority = changes.priority ?? current.priority;

    const anyChange =
      (changes.status !== undefined && changes.status !== current.status) ||
      (changes.priority !== undefined && changes.priority !== current.priority) ||
      (changes.category !== undefined && changes.category !== current.category) ||
      (changes.assigneeId !== undefined && changes.assigneeId !== current.assigneeId) ||
      (changes.tags !== undefined && !sameTags(changes.tags, current.tags));
    if (anyChange && current.status === 'closed') throw ticketClosed();

    if (status !== current.status) {
      const actorRole = ctx.actor?.role ?? 'system';
      if (!canTransition(current.status, status, ctx.trigger, actorRole)) {
        throw invalidTransition(`Transition ${current.status} -> ${status} is not allowed`);
      }
      set.status = status;
      events.push({ field: 'status', from: current.status, to: status });
      if (status === 'resolved') set.resolvedAt = ctx.now;
      if (current.status === 'resolved' && status !== 'closed') set.resolvedAt = null;
      if (status === 'closed') set.closedAt = ctx.now;
      if (
        status === 'resolved' &&
        current.resolutionDueAt &&
        ctx.now > current.resolutionDueAt &&
        !current.slaBreachedResolution
      ) {
        set.slaBreachedResolution = true;
      }
    }

    if (changes.priority !== undefined && changes.priority !== current.priority) {
      set.priority = changes.priority;
      events.push({ field: 'priority', from: current.priority, to: changes.priority });
    }

    if (changes.category !== undefined && changes.category !== current.category) {
      set.category = changes.category;
      events.push({ field: 'category', from: current.category, to: changes.category });
    }

    if (changes.assigneeId !== undefined && changes.assigneeId !== current.assigneeId) {
      await this.assertCanAssign(db, ctx.actor, current, changes.assigneeId);
      set.assigneeId = changes.assigneeId;
      events.push({ field: 'assignee', from: current.assigneeId, to: changes.assigneeId });
      if (changes.assigneeId && changes.assigneeId !== actorId) {
        signals.push(
          ...(await insertNotifications(db, [
            {
              userId: changes.assigneeId,
              kind: 'ticket_assigned',
              ticketId: current.id,
              at: ctx.now,
            },
          ])),
        );
      }
    }

    if (changes.tags !== undefined && !sameTags(changes.tags, current.tags)) {
      set.tags = changes.tags;
      events.push({ field: 'tags', from: current.tags.join(','), to: changes.tags.join(',') });
    }

    const priorityChanged = set.priority !== undefined;
    const firstRespondedAt =
      set.firstRespondedAt !== undefined ? set.firstRespondedAt : current.firstRespondedAt;
    if (set.status !== undefined || priorityChanged || set.firstRespondedAt !== undefined) {
      const sla = await this.sla.refresh(
        db,
        {
          id: current.id,
          createdAt: current.createdAt,
          firstRespondedAt: firstRespondedAt ?? null,
          slaPausedAt: current.slaPausedAt,
          status,
          priority,
          firstResponseDueAt: current.firstResponseDueAt,
          resolutionDueAt: current.resolutionDueAt,
        },
        { previousStatus: current.status, priorityChanged, now: ctx.now },
      );
      Object.assign(set, sla);
      if (priorityChanged) {
        // Breach flags follow the recomputed deadlines.
        const responded = firstRespondedAt ?? null;
        set.slaBreachedFirst =
          !!sla.firstResponseDueAt &&
          (responded ? responded > sla.firstResponseDueAt : ctx.now > sla.firstResponseDueAt);
        const resolved = set.resolvedAt !== undefined ? set.resolvedAt : current.resolvedAt;
        set.slaBreachedResolution =
          !!sla.resolutionDueAt &&
          (resolved
            ? resolved > sla.resolutionDueAt
            : status !== 'pending' && ctx.now > sla.resolutionDueAt);
      }
    }

    const changed = events.length > 0 || Object.keys(ctx.extra ?? {}).length > 0;
    if (!changed) return { row: current, changed: false, signals };

    const [row] = await db
      .update(tickets)
      .set({ ...set, version: sql`${tickets.version} + 1`, updatedAt: ctx.now })
      .where(and(eq(tickets.id, current.id), eq(tickets.version, current.version)))
      .returning();
    if (!row) throw new VersionConflictError(current.id);

    if (events.length > 0) {
      await db.insert(ticketEvents).values(
        events.map((e) => ({
          ticketId: current.id,
          actorId,
          field: e.field,
          fromValue: e.from,
          toValue: e.to,
          createdAt: ctx.now,
        })),
      );
    }
    signals.push({ type: 'ticket.updated', ticketId: current.id });
    return { row, changed: true, signals };
  }

  /**
   * lead: may assign any staff member or unassign.
   * agent: may take a ticket (assign self) or release their own; never assign others.
   */
  private async assertCanAssign(
    db: DbOrTx,
    actor: AuthUser | null,
    current: TicketRow,
    assigneeId: string | null,
  ): Promise<void> {
    if (actor?.role === 'agent') {
      const ok =
        assigneeId === actor.id || (assigneeId === null && current.assigneeId === actor.id);
      if (!ok) throw forbidden('Agents can only assign tickets to themselves');
    }
    if (assigneeId === null) return;
    const [user] = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, assigneeId));
    if (!user || user.role === 'customer') {
      throw new ApiError(422, 'invalid_assignee', 'Assignee must be a staff member');
    }
  }
}
