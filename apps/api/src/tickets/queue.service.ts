import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type {
  BulkAction,
  BulkRequest,
  BulkResponse,
  BulkResult,
  BulkSkipReason,
  Ticket,
} from '@helpdesk/shared';
import type { AuthUser } from '../auth/auth.types.js';
import { Clock } from '../common/clock.js';
import { ApiError, notFound } from '../common/errors.js';
import { DB, type Db } from '../db/db.js';
import { tickets, type TicketRow } from '../db/schema.js';
import { RealtimeService, type RealtimeSignal } from '../realtime/realtime.service.js';
import { ticketScope, toTextArray } from './ticket-access.js';
import { TicketMutations, type TicketChanges } from './ticket-mutations.js';
import { selectTicketById } from './ticket-query.js';

class Skip extends Error {
  constructor(readonly reason: BulkSkipReason) {
    super(reason);
  }
}

@Injectable()
export class QueueService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly clock: Clock,
    private readonly mutations: TicketMutations,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * Picks the most urgent free ticket of the caller's categories and assigns it, in one
   * transaction. FOR UPDATE SKIP LOCKED makes concurrent callers skip rows another
   * transaction is taking, so N simultaneous calls get N different tickets.
   * Urgency: nearest running SLA deadline, then priority, then age.
   */
  async takeNext(user: AuthUser): Promise<Ticket> {
    const result = await this.db.transaction(async (tx) => {
      const categoryFilter =
        user.role === 'lead' ? sql`true` : sql`category = any(${toTextArray(user.categories)})`;
      const res = await tx.execute<{ id: string }>(sql`
        select id from tickets
        where assignee_id is null and status in ('new', 'open') and ${categoryFilter}
        order by sla_sort_at, priority_rank desc, created_at
        limit 1
        for update skip locked`);
      const id = res.rows[0]?.id;
      if (!id) return null;
      const [row] = await tx.select().from(tickets).where(eq(tickets.id, id));
      if (!row) return null;
      const r = await this.mutations.apply(
        tx,
        row,
        { assigneeId: user.id },
        { actor: user, now: this.clock.now(), trigger: 'staff_manual' },
      );
      return { id, signals: r.signals };
    });
    if (!result) {
      throw new ApiError(404, 'no_tickets_available', 'No free tickets in your categories');
    }
    await this.realtime.emit(...result.signals);
    const ticket = await selectTicketById(this.db, user, result.id);
    if (!ticket) throw notFound();
    return ticket;
  }

  /**
   * Applies one action to up to 200 tickets. Each ticket runs in its own savepoint: a
   * failure (no access, invalid transition, …) rolls back only that ticket and is reported
   * with a reason; the rest are committed together.
   */
  async bulk(user: AuthUser, req: BulkRequest): Promise<BulkResponse> {
    const now = this.clock.now();
    const signals: RealtimeSignal[] = [];
    // Lock in a stable order to avoid deadlocks with concurrent bulk requests.
    const ordered = [...req.ids].sort();
    const outcome = new Map<string, BulkResult>();

    await this.db.transaction(async (tx) => {
      for (const id of ordered) {
        try {
          const local = await tx.transaction(async (sp) => {
            const res = await sp.execute<{ id: string; visible: boolean }>(sql`
              select t.id, (${ticketScope(user)}) as visible from tickets t
              where t.id = ${id} for update`);
            const found = res.rows[0];
            if (!found) throw new Skip('not_found');
            if (!found.visible) throw new Skip('forbidden');
            const [row] = await sp.select().from(tickets).where(eq(tickets.id, id));
            if (!row) throw new Skip('not_found');
            const r = await this.mutations.apply(sp, row, this.changes(row, req.action), {
              actor: user,
              now,
              trigger: 'staff_manual',
            });
            return r.signals;
          });
          signals.push(...local);
          outcome.set(id, { id, ok: true });
        } catch (err) {
          outcome.set(id, { id, ok: false, reason: toReason(err) });
        }
      }
    });

    await this.realtime.emit(...signals);
    const results = req.ids.map(
      (id) => outcome.get(id) ?? { id, ok: false as const, reason: 'not_found' as const },
    );
    const succeeded = results.filter((r) => r.ok).length;
    return { results, succeeded, skipped: results.length - succeeded };
  }

  private changes(row: TicketRow, action: BulkAction): TicketChanges {
    switch (action.type) {
      case 'assign':
        return { assigneeId: action.assigneeId };
      case 'status':
        return { status: action.status };
      case 'priority':
        return { priority: action.priority };
      case 'tags': {
        const remove = new Set(action.remove);
        const next = [...new Set([...row.tags, ...action.add])].filter((t) => !remove.has(t));
        return { tags: next };
      }
    }
  }
}

function toReason(err: unknown): BulkSkipReason {
  if (err instanceof Skip) return err.reason;
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'invalid_transition':
        return 'invalid_transition';
      case 'ticket_closed':
        return 'ticket_closed';
      case 'invalid_assignee':
        return 'invalid_assignee';
      case 'forbidden':
        return 'forbidden';
      case 'not_found':
        return 'not_found';
      default:
        break;
    }
  }
  throw err;
}
