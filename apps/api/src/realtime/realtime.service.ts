import { Injectable } from '@nestjs/common';

/**
 * Domain-level realtime signals. Each call is made *after* the transaction commits.
 * Delivery (PostgreSQL NOTIFY -> SSE with per-recipient permission filtering) is
 * implemented by the events module, which registers a sink here.
 */
export type RealtimeSignal =
  | { type: 'ticket.created'; ticketId: string }
  | { type: 'ticket.updated'; ticketId: string }
  | { type: 'message.created'; ticketId: string; messageId: string }
  | { type: 'notification.created'; notificationId: string; userId: string }
  | { type: 'typing'; ticketId: string; userId: string; userName: string };

export type RealtimeSink = (signal: RealtimeSignal) => Promise<void>;

@Injectable()
export class RealtimeService {
  private sink: RealtimeSink | null = null;

  setSink(sink: RealtimeSink | null): void {
    this.sink = sink;
  }

  async emit(...signals: RealtimeSignal[]): Promise<void> {
    if (!this.sink) return;
    for (const s of signals) {
      // Realtime is best effort: a failed NOTIFY must not fail the committed request.
      await this.sink(s).catch(() => undefined);
    }
  }
}
