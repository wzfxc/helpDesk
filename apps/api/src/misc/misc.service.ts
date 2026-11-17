import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  BUILT_IN_VIEWS,
  type CannedResponse,
  type CreateSavedView,
  type MarkNotificationsRead,
  type NotificationList,
  type SavedView,
  type SlaPolicy,
  type Stats,
  type UpdateSlaPolicies,
  type UpsertCannedResponse,
} from '@helpdesk/shared';
import type { AuthUser } from '../auth/auth.types.js';
import { Clock } from '../common/clock.js';
import { notFound } from '../common/errors.js';
import { DB, type Db } from '../db/db.js';
import {
  cannedResponses,
  notifications,
  savedViews,
  slaPauses,
  slaPolicies,
} from '../db/schema.js';
import { createBusinessMinutes, type Pause } from '../sla/business-time.js';
import { SlaService } from '../sla/sla.service.js';

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

@Injectable()
export class MiscService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly clock: Clock,
    private readonly sla: SlaService,
  ) {}

  // ---------- notifications ----------

  async notifications(user: AuthUser, limit = 50): Promise<NotificationList> {
    const res = await this.db.execute<{
      id: string;
      kind: NotificationList['items'][number]['kind'];
      ticket_id: string;
      number: number;
      subject: string;
      due_at: Date | null;
      read_at: Date | null;
      created_at: Date;
    }>(sql`
      select n.id, n.kind, n.ticket_id, t.number, t.subject, n.due_at, n.read_at, n.created_at
      from notifications n join tickets t on t.id = n.ticket_id
      where n.user_id = ${user.id}
      order by n.created_at desc, n.id desc
      limit ${limit}`);
    const unread = await this.db.execute<{ n: number }>(
      sql`select count(*)::int as n from notifications where user_id = ${user.id} and read_at is null`,
    );
    return {
      items: res.rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        ticketId: r.ticket_id,
        ticketNumber: r.number,
        ticketSubject: r.subject,
        dueAt: iso(r.due_at),
        readAt: iso(r.read_at),
        createdAt: new Date(r.created_at).toISOString(),
      })),
      unreadCount: unread.rows[0]?.n ?? 0,
    };
  }

  async markRead(user: AuthUser, input: MarkNotificationsRead): Promise<NotificationList> {
    const own = eq(notifications.userId, user.id);
    const where =
      'all' in input
        ? and(own, isNull(notifications.readAt))
        : and(own, isNull(notifications.readAt), inArray(notifications.id, input.ids));
    await this.db.update(notifications).set({ readAt: this.clock.now() }).where(where);
    return this.notifications(user);
  }

  // ---------- canned responses ----------

  private cannedDto(r: typeof cannedResponses.$inferSelect): CannedResponse {
    return {
      id: r.id,
      title: r.title,
      body: r.body,
      category: r.category,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  async listCanned(): Promise<CannedResponse[]> {
    const rows = await this.db.select().from(cannedResponses).orderBy(cannedResponses.title);
    return rows.map((r) => this.cannedDto(r));
  }

  async createCanned(user: AuthUser, input: UpsertCannedResponse): Promise<CannedResponse> {
    const now = this.clock.now();
    const [row] = await this.db
      .insert(cannedResponses)
      .values({ ...input, createdBy: user.id, createdAt: now, updatedAt: now })
      .returning();
    if (!row) throw new Error('insert failed');
    return this.cannedDto(row);
  }

  async updateCanned(id: string, input: UpsertCannedResponse): Promise<CannedResponse> {
    const [row] = await this.db
      .update(cannedResponses)
      .set({ ...input, updatedAt: this.clock.now() })
      .where(eq(cannedResponses.id, id))
      .returning();
    if (!row) throw notFound('Canned response not found');
    return this.cannedDto(row);
  }

  async deleteCanned(id: string): Promise<void> {
    const rows = await this.db
      .delete(cannedResponses)
      .where(eq(cannedResponses.id, id))
      .returning({ id: cannedResponses.id });
    if (rows.length === 0) throw notFound('Canned response not found');
  }

  // ---------- saved views ----------

  async listViews(user: AuthUser): Promise<SavedView[]> {
    const own = await this.db
      .select()
      .from(savedViews)
      .where(eq(savedViews.userId, user.id))
      .orderBy(savedViews.createdAt);
    return [
      ...BUILT_IN_VIEWS.map((v) => ({ id: v.id, name: v.key, builtIn: true, query: v.query })),
      ...own.map((v) => ({ id: v.id, name: v.name, builtIn: false, query: v.query })),
    ];
  }

  async createView(user: AuthUser, input: CreateSavedView): Promise<SavedView> {
    const [row] = await this.db
      .insert(savedViews)
      .values({
        userId: user.id,
        name: input.name,
        query: input.query,
        createdAt: this.clock.now(),
      })
      .returning();
    if (!row) throw new Error('insert failed');
    return { id: row.id, name: row.name, builtIn: false, query: row.query };
  }

  async deleteView(user: AuthUser, id: string): Promise<void> {
    const rows = await this.db
      .delete(savedViews)
      .where(and(eq(savedViews.id, id), eq(savedViews.userId, user.id)))
      .returning({ id: savedViews.id });
    if (rows.length === 0) throw notFound('View not found');
  }

  // ---------- SLA policies ----------

  policies(): Promise<SlaPolicy[]> {
    return this.sla.policies(this.db);
  }

  /** Applies to new tickets and to tickets whose priority changes afterwards (README). */
  async updatePolicies(user: AuthUser, input: UpdateSlaPolicies): Promise<SlaPolicy[]> {
    const now = this.clock.now();
    await this.db.transaction(async (tx) => {
      for (const p of input.policies) {
        await tx
          .update(slaPolicies)
          .set({
            firstResponseMinutes: p.firstResponseMinutes,
            resolutionMinutes: p.resolutionMinutes,
            updatedAt: now,
            updatedBy: user.id,
          })
          .where(eq(slaPolicies.priority, p.priority));
      }
    });
    return this.policies();
  }

  // ---------- stats ----------

  async stats(from: Date, to: Date): Promise<Stats> {
    const counts = await this.db.execute<{
      created: number;
      resolved: number;
      breached: number;
      avg_rating: number | null;
      ratings: number;
    }>(sql`
      select
        count(*) filter (where created_at >= ${from} and created_at < ${to})::int as created,
        count(*) filter (where resolved_at >= ${from} and resolved_at < ${to})::int as resolved,
        count(*) filter (where created_at >= ${from} and created_at < ${to}
          and (sla_breached_first or sla_breached_resolution))::int as breached,
        avg(rating_score) filter (where rated_at >= ${from} and rated_at < ${to}) as avg_rating,
        count(*) filter (where rated_at >= ${from} and rated_at < ${to})::int as ratings
      from tickets`);
    const c = counts.rows[0];

    // Averages are measured in business minutes (the same clock as the SLA), net of pauses.
    // Fast path: tickets without pauses (the vast majority) travel as three packed float8
    // arrays (epoch ms) in ONE row; shipping 20 000 separate rows costs more than the SQL itself.
    const inPeriod = sql`((t.first_responded_at >= ${from} and t.first_responded_at < ${to})
      or (t.resolved_at >= ${from} and t.resolved_at < ${to}))`;
    const packed = await this.db.execute<{
      created: number[] | null;
      first: (number | null)[] | null;
      resolved: (number | null)[] | null;
    }>(sql`
      select
        json_agg((extract(epoch from t.created_at) * 1000)::float8) as created,
        json_agg((extract(epoch from t.first_responded_at) * 1000)::float8) as first,
        json_agg((extract(epoch from t.resolved_at) * 1000)::float8) as resolved
      from tickets t
      where ${inPeriod} and not exists (select 1 from sla_pauses p where p.ticket_id = t.id)`);
    // Tickets that were ever paused (a few percent) are fetched row by row with their pauses.
    const pausedRows = await this.db.execute<{
      id: string;
      created_ms: number;
      first_ms: number | null;
      resolved_ms: number | null;
    }>(sql`
      select t.id,
        (extract(epoch from t.created_at) * 1000)::float8 as created_ms,
        (extract(epoch from t.first_responded_at) * 1000)::float8 as first_ms,
        (extract(epoch from t.resolved_at) * 1000)::float8 as resolved_ms
      from tickets t
      where ${inPeriod} and exists (select 1 from sla_pauses p where p.ticket_id = t.id)`);
    const pauseRows = pausedRows.rows.length
      ? await this.db
          .select()
          .from(slaPauses)
          .where(
            inArray(
              slaPauses.ticketId,
              pausedRows.rows.map((r) => r.id),
            ),
          )
      : [];
    const pausesBy = new Map<string, Pause[]>();
    for (const p of pauseRows) {
      const list = pausesBy.get(p.ticketId) ?? [];
      list.push({ start: new Date(p.startedAt), end: p.endedAt ? new Date(p.endedAt) : null });
      pausesBy.set(p.ticketId, list);
    }

    const fromMs = from.getTime();
    const toMs = to.getTime();
    const plainCreated = packed.rows[0]?.created ?? [];
    const plainFirst = packed.rows[0]?.first ?? [];
    const plainResolved = packed.rows[0]?.resolved ?? [];
    const earliest = Math.min(
      ...plainCreated,
      ...pausedRows.rows.map((r) => r.created_ms),
      Number.POSITIVE_INFINITY,
    );
    const clock = createBusinessMinutes(new Date(earliest), to);
    let firstSum = 0;
    let firstN = 0;
    let resolutionSum = 0;
    let resolutionN = 0;
    const add = (
      createdMs: number,
      firstMs: number | null,
      resolvedMs: number | null,
      pauses?: Pause[],
    ): void => {
      if (firstMs !== null && firstMs >= fromMs && firstMs < toMs) {
        firstSum += clock(createdMs, firstMs, pauses);
        firstN += 1;
      }
      if (resolvedMs !== null && resolvedMs >= fromMs && resolvedMs < toMs) {
        resolutionSum += clock(createdMs, resolvedMs, pauses);
        resolutionN += 1;
      }
    };
    for (let i = 0; i < plainCreated.length; i++) {
      add(plainCreated[i] as number, plainFirst[i] ?? null, plainResolved[i] ?? null);
    }
    for (const r of pausedRows.rows)
      add(r.created_ms, r.first_ms, r.resolved_ms, pausesBy.get(r.id));
    const avg = (sum: number, n: number): number | null =>
      n ? Math.round((sum / n) * 10) / 10 : null;
    const agents = await this.db.execute<{
      id: string;
      name: string;
      open_assigned: number;
      resolved: number;
      replies: number;
    }>(sql`
      select u.id, u.name,
        (select count(*)::int from tickets t where t.assignee_id = u.id
           and t.status in ('new', 'open', 'pending')) as open_assigned,
        (select count(*)::int from tickets t where t.assignee_id = u.id
           and t.resolved_at >= ${from} and t.resolved_at < ${to}) as resolved,
        (select count(*)::int from messages m where m.author_id = u.id and not m.internal
           and m.created_at >= ${from} and m.created_at < ${to}) as replies
      from users u where u.role in ('agent', 'lead') order by u.name`);

    const created = c?.created ?? 0;
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      created,
      resolved: c?.resolved ?? 0,
      avgFirstResponseMinutes: avg(firstSum, firstN),
      avgResolutionMinutes: avg(resolutionSum, resolutionN),
      slaBreachRate: created > 0 ? Math.round(((c?.breached ?? 0) / created) * 1000) / 1000 : null,
      avgRating:
        c?.avg_rating === null || c?.avg_rating === undefined
          ? null
          : Math.round(c.avg_rating * 100) / 100,
      ratingsCount: c?.ratings ?? 0,
      agents: agents.rows.map((a) => ({
        id: a.id,
        name: a.name,
        openAssigned: a.open_assigned,
        resolvedInPeriod: a.resolved,
        repliesInPeriod: a.replies,
      })),
    };
  }

  /** Sorted newest-first helper used by tests. */
  async latestNotificationFor(userId: string) {
    const [row] = await this.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(desc(notifications.createdAt))
      .limit(1);
    return row;
  }
}
