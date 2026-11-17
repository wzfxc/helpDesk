import type { NotificationKind } from '@helpdesk/shared';
import type { DbOrTx } from '../db/db.js';
import { notifications } from '../db/schema.js';
import type { RealtimeSignal } from '../realtime/realtime.service.js';

/** Inserts notifications in the caller's transaction and returns the signals to emit after commit. */
export async function insertNotifications(
  db: DbOrTx,
  items: {
    userId: string;
    kind: NotificationKind;
    ticketId: string;
    dueAt?: Date | null;
    at: Date;
  }[],
): Promise<RealtimeSignal[]> {
  if (items.length === 0) return [];
  const rows = await db
    .insert(notifications)
    .values(
      items.map((i) => ({
        userId: i.userId,
        kind: i.kind,
        ticketId: i.ticketId,
        dueAt: i.dueAt ?? null,
        createdAt: i.at,
      })),
    )
    .returning({ id: notifications.id, userId: notifications.userId });
  return rows.map((r) => ({
    type: 'notification.created' as const,
    notificationId: r.id,
    userId: r.userId,
  }));
}
