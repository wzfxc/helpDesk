import { rm } from 'node:fs/promises';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { LIMITS, type SlaKind } from '@helpdesk/shared';
import { Clock } from '../common/clock.js';
import { DB, type Db, type DbOrTx } from '../db/db.js';
import { tickets } from '../db/schema.js';
import { insertNotifications } from '../notifications/notify.js';
import { RealtimeService, type RealtimeSignal } from '../realtime/realtime.service.js';
import { TicketMutations } from '../tickets/ticket-mutations.js';
import { AttachmentsService } from '../attachments/attachments.service.js';

const MINUTE = 60_000;
const BATCH = 500;

interface AlertRow {
  ticket_id: string;
  sla_kind: SlaKind;
  due_at: Date;
  assignee_id: string | null;
}

/**
 * Background job bodies. Each one is idempotent and "catches up": it processes everything
 * that is due at `clock.now()`, so a missed or repeated run neither loses nor duplicates work.
 * Tests call them directly with a fake clock.
 */
@Injectable()
export class JobHandlers {
  private readonly logger = new Logger('Jobs');

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly clock: Clock,
    private readonly mutations: TicketMutations,
    private readonly realtime: RealtimeService,
    private readonly attachments: AttachmentsService,
  ) {}

  /**
   * SLA scan: flags breaches and warns 30 minutes before a deadline. The `sla_alerts`
   * ledger (primary key ticket+alert+kind+due_at) guarantees one warning/breach per deadline,
   * even across restarts or concurrent scans; a recomputed deadline gets its own alerts.
   */
  async slaScan(): Promise<{ warnings: number; breaches: number }> {
    const now = this.clock.now();
    const warnBefore = new Date(now.getTime() + LIMITS.slaWarningMinutes * MINUTE);
    const signals: RealtimeSignal[] = [];
    const counts = await this.db.transaction(async (tx) => {
      const breaches = await tx.execute<AlertRow & Record<string, unknown>>(sql`
        with due as (
          select t.id, 'first_response' as sla_kind, t.first_response_due_at as due_at, t.assignee_id
          from tickets t
          where t.status in ('new', 'open') and t.first_responded_at is null
            and t.first_response_due_at <= ${now} and t.next_due_at is not null
          union all
          select t.id, 'resolution', t.resolution_due_at, t.assignee_id
          from tickets t
          where t.status in ('new', 'open') and t.resolution_due_at <= ${now}
            and t.next_due_at is not null
        ), inserted as (
          insert into sla_alerts (ticket_id, alert, sla_kind, due_at, created_at)
          select id, 'breach', sla_kind, due_at, ${now} from due
          on conflict do nothing
          returning ticket_id, sla_kind, due_at
        )
        select i.ticket_id, i.sla_kind, i.due_at, d.assignee_id
        from inserted i join due d on d.id = i.ticket_id and d.sla_kind = i.sla_kind`);
      for (const b of breaches.rows) {
        await tx
          .update(tickets)
          .set(
            b.sla_kind === 'first_response'
              ? { slaBreachedFirst: true }
              : { slaBreachedResolution: true },
          )
          .where(sql`${tickets.id} = ${b.ticket_id}`);
        signals.push({ type: 'ticket.updated', ticketId: b.ticket_id });
      }
      signals.push(...(await this.alertNotifications(tx, breaches.rows, 'sla_breached', now)));

      const warnings = await tx.execute<AlertRow & Record<string, unknown>>(sql`
        with due as (
          select t.id, 'first_response' as sla_kind, t.first_response_due_at as due_at, t.assignee_id
          from tickets t
          where t.status in ('new', 'open') and t.first_responded_at is null
            and t.first_response_due_at > ${now} and t.first_response_due_at <= ${warnBefore}
            and t.next_due_at is not null
          union all
          select t.id, 'resolution', t.resolution_due_at, t.assignee_id
          from tickets t
          where t.status in ('new', 'open')
            and t.resolution_due_at > ${now} and t.resolution_due_at <= ${warnBefore}
            and t.next_due_at is not null
        ), inserted as (
          insert into sla_alerts (ticket_id, alert, sla_kind, due_at, created_at)
          select id, 'warning', sla_kind, due_at, ${now} from due
          on conflict do nothing
          returning ticket_id, sla_kind, due_at
        )
        select i.ticket_id, i.sla_kind, i.due_at, d.assignee_id
        from inserted i join due d on d.id = i.ticket_id and d.sla_kind = i.sla_kind`);
      // Warnings go to the assignee only ("warn the assignee 30 minutes before").
      signals.push(
        ...(await insertNotifications(
          tx,
          warnings.rows.flatMap((w) =>
            w.assignee_id
              ? [
                  {
                    userId: w.assignee_id,
                    kind: 'sla_warning' as const,
                    ticketId: w.ticket_id,
                    dueAt: new Date(w.due_at),
                    at: now,
                  },
                ]
              : [],
          ),
        )),
      );
      return { warnings: warnings.rows.length, breaches: breaches.rows.length };
    });
    await this.realtime.emit(...signals);
    return counts;
  }

  /** Breach -> assignee; unassigned tickets -> all leads. */
  private async alertNotifications(
    tx: DbOrTx,
    rows: AlertRow[],
    kind: 'sla_breached',
    now: Date,
  ): Promise<RealtimeSignal[]> {
    if (rows.length === 0) return [];
    const leads = await tx.execute<{ id: string }>(sql`select id from users where role = 'lead'`);
    const items = rows.flatMap((r) =>
      (r.assignee_id ? [r.assignee_id] : leads.rows.map((l) => l.id)).map((userId) => ({
        userId,
        kind,
        ticketId: r.ticket_id,
        dueAt: new Date(r.due_at),
        at: now,
      })),
    );
    return insertNotifications(tx, items);
  }

  /** resolved for 3 days without a customer reply -> closed (system actor). */
  async autoClose(): Promise<number> {
    const now = this.clock.now();
    const cutoff = new Date(now.getTime() - LIMITS.autoCloseDays * 24 * 60 * MINUTE);
    let total = 0;
    for (;;) {
      const { closed, signals } = await this.db.transaction(async (tx) => {
        const res = await tx.execute<{ id: string }>(sql`
          select id from tickets
          where status = 'resolved' and resolved_at <= ${cutoff}
          order by resolved_at
          limit ${BATCH}
          for update skip locked`);
        const out: RealtimeSignal[] = [];
        for (const { id } of res.rows) {
          const [row] = await tx
            .select()
            .from(tickets)
            .where(sql`${tickets.id} = ${id}`);
          if (!row) continue;
          const r = await this.mutations.apply(
            tx,
            row,
            { status: 'closed' },
            {
              actor: null,
              now,
              trigger: 'auto_close',
            },
          );
          out.push(...r.signals);
        }
        return { closed: res.rows.length, signals: out };
      });
      await this.realtime.emit(...signals);
      total += closed;
      if (closed < BATCH) break;
    }
    return total;
  }

  /** Attachments never bound to a message are removed after 24 hours (rows, then files). */
  async cleanupAttachments(): Promise<number> {
    const now = this.clock.now();
    const cutoff = new Date(now.getTime() - LIMITS.orphanAttachmentHours * 60 * MINUTE);
    let total = 0;
    for (;;) {
      const res = await this.db.execute<{ storage_key: string }>(sql`
        delete from attachments where id in (
          select id from attachments
          where message_id is null and created_at < ${cutoff}
          order by created_at
          limit ${BATCH}
          for update skip locked
        )
        returning storage_key`);
      for (const { storage_key } of res.rows) {
        await rm(this.attachments.filePath(storage_key), { force: true }).catch((err: unknown) => {
          this.logger.warn(`could not delete ${storage_key}: ${String(err)}`);
        });
      }
      total += res.rows.length;
      if (res.rows.length < BATCH) break;
    }
    return total;
  }

  /** Expired sessions, old login attempts and finished jobs. */
  async housekeeping(): Promise<void> {
    const now = this.clock.now();
    await this.db.execute(sql`delete from sessions where expires_at < ${now}`);
    await this.db.execute(
      sql`delete from login_attempts where attempted_at < ${new Date(now.getTime() - 24 * 60 * MINUTE)}`,
    );
    await this.db.execute(sql`
      delete from jobs where status in ('done', 'failed')
        and finished_at < ${new Date(now.getTime() - 7 * 24 * 60 * MINUTE)}`);
  }
}
