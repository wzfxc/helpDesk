import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Priority, SlaPolicy, Status } from '@helpdesk/shared';
import type { DbOrTx } from '../db/db.js';
import { FAR_FUTURE, slaPauses, slaPolicies, type TicketRow } from '../db/schema.js';
import type { Pause } from './business-time.js';
import { computeDeadlines, isPausedStatus, nextDueAt } from './deadlines.js';

export interface SlaFields {
  firstResponseDueAt: Date | null;
  resolutionDueAt: Date | null;
  nextDueAt: Date | null;
  slaSortAt: Date;
  slaPausedAt: Date | null;
}

/**
 * SLA bookkeeping inside the caller's transaction:
 * - deadlines = createdAt + policy minutes in business time, skipping every pause so far;
 * - pending/resolved/closed open a pause, returning to new/open closes it and recomputes.
 */
@Injectable()
export class SlaService {
  async policies(db: DbOrTx): Promise<SlaPolicy[]> {
    return db
      .select({
        priority: slaPolicies.priority,
        firstResponseMinutes: slaPolicies.firstResponseMinutes,
        resolutionMinutes: slaPolicies.resolutionMinutes,
      })
      .from(slaPolicies)
      .orderBy(asc(slaPolicies.priority));
  }

  async policy(db: DbOrTx, priority: Priority): Promise<SlaPolicy> {
    const [row] = await db
      .select({
        priority: slaPolicies.priority,
        firstResponseMinutes: slaPolicies.firstResponseMinutes,
        resolutionMinutes: slaPolicies.resolutionMinutes,
      })
      .from(slaPolicies)
      .where(eq(slaPolicies.priority, priority));
    if (!row) throw new Error(`SLA policy for ${priority} is missing`);
    return row;
  }

  async pauses(db: DbOrTx, ticketId: string): Promise<Pause[]> {
    const rows = await db
      .select({ start: slaPauses.startedAt, end: slaPauses.endedAt })
      .from(slaPauses)
      .where(eq(slaPauses.ticketId, ticketId))
      .orderBy(asc(slaPauses.startedAt));
    return rows;
  }

  /** Fields for a brand-new ticket. */
  async initial(db: DbOrTx, priority: Priority, createdAt: Date): Promise<SlaFields> {
    const policy = await this.policy(db, priority);
    const due = computeDeadlines(createdAt, policy, []);
    const next = nextDueAt({ status: 'new', firstRespondedAt: null, ...due });
    return { ...due, nextDueAt: next, slaSortAt: next ?? FAR_FUTURE, slaPausedAt: null };
  }

  /**
   * Applies a status change to the pause ledger and returns refreshed SLA fields.
   * `ticket` holds the values *after* the change except for SLA fields.
   */
  async refresh(
    db: DbOrTx,
    ticket: Pick<TicketRow, 'id' | 'createdAt' | 'firstRespondedAt' | 'slaPausedAt'> & {
      status: Status;
      priority: Priority;
      firstResponseDueAt: Date | null;
      resolutionDueAt: Date | null;
    },
    opts: { previousStatus: Status; priorityChanged: boolean; now: Date },
  ): Promise<SlaFields> {
    const wasPaused = isPausedStatus(opts.previousStatus);
    const nowPaused = isPausedStatus(ticket.status);
    let slaPausedAt = ticket.slaPausedAt;

    if (!wasPaused && nowPaused) {
      await db
        .insert(slaPauses)
        .values({ ticketId: ticket.id, startedAt: opts.now })
        .onConflictDoNothing();
      slaPausedAt = opts.now;
    } else if (wasPaused && !nowPaused) {
      await db
        .update(slaPauses)
        .set({ endedAt: opts.now })
        .where(and(eq(slaPauses.ticketId, ticket.id), isNull(slaPauses.endedAt)));
      slaPausedAt = null;
    }

    let { firstResponseDueAt, resolutionDueAt } = ticket;
    if (opts.priorityChanged || (wasPaused && !nowPaused)) {
      const policy = await this.policy(db, ticket.priority);
      const pauses = await this.pauses(db, ticket.id);
      const due = computeDeadlines(ticket.createdAt, policy, pauses);
      // While paused the deadline is unknown; keep the last known value for display.
      firstResponseDueAt = due.firstResponseDueAt ?? firstResponseDueAt;
      resolutionDueAt = due.resolutionDueAt ?? resolutionDueAt;
      if (opts.priorityChanged && nowPaused) {
        const closedOnly = pauses.map((p) => ({ start: p.start, end: p.end ?? opts.now }));
        const shown = computeDeadlines(ticket.createdAt, policy, closedOnly);
        firstResponseDueAt = shown.firstResponseDueAt;
        resolutionDueAt = shown.resolutionDueAt;
      }
    }
    const next = nextDueAt({
      status: ticket.status,
      firstRespondedAt: ticket.firstRespondedAt,
      firstResponseDueAt,
      resolutionDueAt,
    });
    return {
      firstResponseDueAt,
      resolutionDueAt,
      nextDueAt: next,
      slaSortAt: next ?? FAR_FUTURE,
      slaPausedAt,
    };
  }
}
