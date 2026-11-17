'use client';

import clsx from 'clsx';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import type { Priority, Status, Ticket } from '@helpdesk/shared';
import { Badge } from './ui';

export function StatusBadge({ status }: { status: Status }) {
  const t = useTranslations('status');
  return <Badge kind={status}>{t(status)}</Badge>;
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  const t = useTranslations('priority');
  return <Badge kind={priority}>{t(priority)}</Badge>;
}

export const isOverdue = (ticket: Ticket, now: number): boolean =>
  ticket.nextDueAt !== null && Date.parse(ticket.nextDueAt) < now;

/**
 * Live SLA countdown. `useNow` renders the same instant on server and client first and
 * then ticks every 30 s, so there is no hydration mismatch.
 */
export function SlaTimer({ ticket }: { ticket: Ticket }) {
  const t = useTranslations('ticket');
  const format = useFormatter();
  const now = useNow({ updateInterval: 30_000 });
  if (ticket.slaPaused)
    return <span className="text-slate-600 dark:text-slate-400">{t('paused')}</span>;
  if (!ticket.nextDueAt)
    return <span className="text-slate-600 dark:text-slate-400">{t('noTimer')}</span>;
  const due = new Date(ticket.nextDueAt);
  const overdue = due.getTime() < now.getTime();
  return (
    <time
      dateTime={ticket.nextDueAt}
      title={format.dateTime(due, { dateStyle: 'medium', timeStyle: 'short' })}
      className={clsx(overdue && 'font-semibold text-red-700 dark:text-red-400')}
    >
      {overdue ? `${t('overdue')}: ` : ''}
      {format.relativeTime(due, now)}
    </time>
  );
}

export function DateTime({ value }: { value: string }) {
  const format = useFormatter();
  return (
    <time dateTime={value}>
      {format.dateTime(new Date(value), { dateStyle: 'medium', timeStyle: 'short' })}
    </time>
  );
}

export function RelativeTime({ value }: { value: string }) {
  const format = useFormatter();
  const now = useNow({ updateInterval: 30_000 });
  return (
    <time
      dateTime={value}
      title={format.dateTime(new Date(value), { dateStyle: 'medium', timeStyle: 'short' })}
    >
      {format.relativeTime(new Date(value), now)}
    </time>
  );
}
