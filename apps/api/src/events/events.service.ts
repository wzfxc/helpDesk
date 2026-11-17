import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { Client } from 'pg';
import { LIMITS, SSE_HEARTBEAT_MS, type ServerEvent } from '@helpdesk/shared';
import type { AuthUser } from '../auth/auth.types.js';
import { sendApiError } from '../common/error.filter.js';
import { ApiError } from '../common/errors.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DB, type Db } from '../db/db.js';
import { RealtimeService, type RealtimeSignal } from '../realtime/realtime.service.js';
import { selectMessages } from '../tickets/ticket-detail.js';
import { selectTicketById } from '../tickets/ticket-query.js';

const CHANNEL = 'hd_events';

interface Subscriber {
  user: AuthUser;
  res: Response;
  heartbeat: NodeJS.Timeout;
  closed: boolean;
}

/**
 * Realtime fan-out over PostgreSQL LISTEN/NOTIFY, so it also works with several api
 * instances and needs no Redis. NOTIFY carries only a small signal (ids); every instance
 * turns it into a full event *per connected user* through the same permission-scoped
 * queries as the REST endpoints — a customer can never receive an internal note.
 */
@Injectable()
export class EventsService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private static readonly REPLAY_LIMIT = 500;
  private readonly logger = new Logger('Events');
  private readonly subscribers = new Set<Subscriber>();
  /** open streams per user id (includes streams still replaying) */
  private readonly openByUser = new Map<string, number>();
  private readonly recent: { id: number; signal: RealtimeSignal }[] = [];
  private listener: Client | null = null;
  private closing = false;
  private nextId = 1;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly realtime: RealtimeService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.realtime.setSink(async (signal) => {
      await this.db.execute(sql`select pg_notify(${CHANNEL}, ${JSON.stringify(signal)})`);
    });
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.closing) return;
    const client = new Client({ connectionString: this.config.DATABASE_URL });
    client.on('notification', (msg) => {
      if (msg.channel !== CHANNEL || !msg.payload) return;
      try {
        void this.dispatch(JSON.parse(msg.payload) as RealtimeSignal).catch((err: unknown) => {
          this.logger.warn(`dispatch failed: ${String(err)}`);
        });
      } catch {
        this.logger.warn('ignoring malformed notification payload');
      }
    });
    client.on('error', () => {
      void this.reconnect(client);
    });
    client.on('end', () => {
      void this.reconnect(client);
    });
    try {
      await client.connect();
      await client.query(`listen ${CHANNEL}`);
      this.listener = client;
    } catch (err) {
      this.logger.warn(`LISTEN failed: ${String(err)}`);
      void this.reconnect(client);
    }
  }

  private reconnecting = false;
  private async reconnect(old: Client): Promise<void> {
    if (this.closing || this.reconnecting) return;
    this.reconnecting = true;
    old.removeAllListeners();
    old.on('error', () => undefined);
    await old.end().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 1000));
    this.reconnecting = false;
    await this.connect();
  }

  /** Opens the SSE stream for a user, replaying missed events when Last-Event-ID is given. */
  subscribe(user: AuthUser, res: Response, lastEventId?: number): void {
    // Cap simultaneous streams per user: a loop opening tabs must not exhaust sockets/pool.
    if ((this.openByUser.get(user.id) ?? 0) >= LIMITS.sseMaxPerUser) {
      sendApiError(
        res,
        new ApiError(
          429,
          'rate_limited',
          'Too many open event streams for this account',
          undefined,
          { retryAfterSeconds: 10 },
          { 'Retry-After': '10' },
        ),
      );
      return;
    }
    this.openByUser.set(user.id, (this.openByUser.get(user.id) ?? 0) + 1);
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Tells reverse proxies (nginx) not to buffer the stream.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n: connected\n\n');
    const sub: Subscriber = {
      user,
      res,
      closed: false,
      heartbeat: setInterval(() => {
        res.write(': ping\n\n');
      }, SSE_HEARTBEAT_MS),
    };
    res.on('close', () => {
      sub.closed = true;
      clearInterval(sub.heartbeat);
      this.subscribers.delete(sub);
      const left = (this.openByUser.get(user.id) ?? 1) - 1;
      if (left <= 0) this.openByUser.delete(user.id);
      else this.openByUser.set(user.id, left);
    });
    if (lastEventId !== undefined && this.recent.some((entry) => entry.id > lastEventId)) {
      void this.replayAndSubscribe(sub, lastEventId);
    } else {
      this.subscribers.add(sub);
    }
  }

  private isOpen(sub: Subscriber): boolean {
    return !this.closing && !sub.closed && !sub.res.writableEnded;
  }

  private async replayAndSubscribe(sub: Subscriber, lastEventId: number): Promise<void> {
    let cursor = lastEventId;
    try {
      while (this.isOpen(sub)) {
        const batch = this.recent.filter((entry) => entry.id > cursor);
        if (batch.length === 0) break;
        for (const entry of batch) {
          cursor = entry.id;
          const event = await this.buildEvent(sub.user, entry.signal);
          if (!this.isOpen(sub)) return;
          if (event) this.send(sub, entry.id, event);
        }
      }
    } catch (err) {
      this.logger.warn(`replay for ${sub.user.id} failed: ${String(err)}`);
    }
    if (this.closing) {
      clearInterval(sub.heartbeat);
      sub.res.end();
    } else if (this.isOpen(sub)) {
      this.subscribers.add(sub);
    }
  }

  get connections(): number {
    return this.subscribers.size;
  }

  private send(sub: Subscriber, id: number, event: ServerEvent): void {
    sub.res.write(`id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  private async dispatch(signal: RealtimeSignal): Promise<void> {
    const id = this.nextId++;
    if (signal.type !== 'typing') {
      this.recent.push({ id, signal });
      if (this.recent.length > EventsService.REPLAY_LIMIT) {
        this.recent.splice(0, this.recent.length - EventsService.REPLAY_LIMIT);
      }
    }
    await Promise.all(
      [...this.subscribers].map(async (sub) => {
        try {
          const event = await this.buildEvent(sub.user, signal);
          if (event && !sub.closed && !sub.res.writableEnded) this.send(sub, id, event);
        } catch (err) {
          this.logger.warn(`event for ${sub.user.id} failed: ${String(err)}`);
        }
      }),
    );
  }

  /** Converts a signal into the event this specific user may see (or null). */
  async buildEvent(user: AuthUser, signal: RealtimeSignal): Promise<ServerEvent | null> {
    switch (signal.type) {
      case 'ticket.created':
      case 'ticket.updated': {
        const ticket = await selectTicketById(this.db, user, signal.ticketId);
        return ticket ? { type: signal.type, ticket } : null;
      }
      case 'message.created': {
        const ticket = await selectTicketById(this.db, user, signal.ticketId);
        if (!ticket) return null;
        // Internal notes are filtered in SQL for customers: an empty result means "not visible".
        const [message] = await selectMessages(this.db, user, sql`m.id = ${signal.messageId}`);
        return message ? { type: 'message.created', ticketId: signal.ticketId, message } : null;
      }
      case 'notification.created': {
        if (signal.userId !== user.id) return null;
        const res = await this.db.execute<{
          id: string;
          kind: 'ticket_assigned' | 'customer_replied' | 'sla_warning' | 'sla_breached';
          ticket_id: string;
          number: number;
          subject: string;
          due_at: Date | null;
          read_at: Date | null;
          created_at: Date;
        }>(sql`
          select n.id, n.kind, n.ticket_id, t.number, t.subject, n.due_at, n.read_at, n.created_at
          from notifications n join tickets t on t.id = n.ticket_id
          where n.id = ${signal.notificationId} and n.user_id = ${user.id}`);
        const n = res.rows[0];
        if (!n) return null;
        return {
          type: 'notification.created',
          notification: {
            id: n.id,
            kind: n.kind,
            ticketId: n.ticket_id,
            ticketNumber: n.number,
            ticketSubject: n.subject,
            dueAt: n.due_at ? new Date(n.due_at).toISOString() : null,
            readAt: null,
            createdAt: new Date(n.created_at).toISOString(),
          },
        };
      }
      case 'typing': {
        if (user.role === 'customer' || signal.userId === user.id) return null;
        const ticket = await selectTicketById(this.db, user, signal.ticketId);
        return ticket
          ? {
              type: 'typing',
              ticketId: signal.ticketId,
              user: { id: signal.userId, name: signal.userName },
            }
          : null;
      }
    }
  }

  /** Closes streams first so the HTTP server can finish shutting down. */
  async beforeApplicationShutdown(): Promise<void> {
    this.closing = true;
    this.realtime.setSink(null);
    for (const sub of this.subscribers) {
      clearInterval(sub.heartbeat);
      sub.res.end();
    }
    this.subscribers.clear();
    const l = this.listener;
    this.listener = null;
    if (l) {
      l.removeAllListeners();
      l.on('error', () => undefined);
      await l.end().catch(() => undefined);
    }
  }
}
