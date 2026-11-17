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
import { cannedResponses, notifications, savedViews, slaPolicies } from '../db/schema.js';
import { businessMinutesBetween, type Pause } from '../sla/business-time.js';
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
    const sample = await this.db.execute<{
      id: string;
      created_at: Date;
      first_responded_at: Date | null;
      resolved_at: Date | null;
    }>(sql`
      select id, created_at, first_responded_at, resolved_at from tickets
      where (first_responded_at >= ${from} and first_responded_at < ${to})
         or (resolved_at >= ${from} and resolved_at < ${to})`);
    const pauseRows = sample.rows.length
      ? await this.db.execute<{ ticket_id: string; started_at: Date; ended_at: Date | null }>(sql`
          select ticket_id, started_at, ended_at from sla_pauses
          where ticket_id in (
            select id from tickets
            where (first_responded_at >= ${from} and first_responded_at < ${to})
               or (resolved_at >= ${from} and resolved_at < ${to}))`)
      : { rows: [] };
    const pausesBy = new Map<string, Pause[]>();
    for (const p of pauseRows.rows) {
      const list = pausesBy.get(p.ticket_id) ?? [];
      list.push({ start: new Date(p.started_at), end: p.ended_at ? new Date(p.ended_at) : null });
      pausesBy.set(p.ticket_id, list);
    }
    const firsts: number[] = [];
    const resolutions: number[] = [];
    for (const t of sample.rows) {
      const created = new Date(t.created_at);
      const pauses = pausesBy.get(t.id) ?? [];
      if (t.first_responded_at) {
        const at = new Date(t.first_responded_at);
        if (at >= from && at < to) firsts.push(businessMinutesBetween(created, at, pauses));
      }
      if (t.resolved_at) {
        const at = new Date(t.resolved_at);
        if (at >= from && at < to) resolutions.push(businessMinutesBetween(created, at, pauses));
      }
    }
    const avg = (xs: number[]): number | null =>
      xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null;

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
      avgFirstResponseMinutes: avg(firsts),
      avgResolutionMinutes: avg(resolutions),
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
