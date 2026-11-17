'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import type { Message, StaffMember, TicketEvent } from '@helpdesk/shared';
import { DateTime } from './ticket-bits';

type Entry =
  | { kind: 'message'; at: string; message: Message }
  | { kind: 'event'; at: string; event: TicketEvent };

/** Messages, internal notes and field changes in one chronological feed. */
export function Timeline({
  messages,
  events,
  staff,
}: {
  messages: Message[];
  events: TicketEvent[];
  staff: StaffMember[] | undefined;
}) {
  const t = useTranslations();
  const entries = useMemo<Entry[]>(
    () =>
      [
        ...messages.map((message): Entry => ({ kind: 'message', at: message.createdAt, message })),
        ...events.map((event): Entry => ({ kind: 'event', at: event.createdAt, event })),
      ].sort((a, b) => a.at.localeCompare(b.at)),
    [messages, events],
  );

  const value = (field: TicketEvent['field'], v: string | null): string => {
    if (v === null || v === '') return t('common.none');
    if (field === 'status') return t(`status.${v}`);
    if (field === 'priority') return t(`priority.${v}`);
    if (field === 'category') return t(`category.${v}`);
    if (field === 'assignee') return staff?.find((s) => s.id === v)?.name ?? v.slice(0, 8);
    return v;
  };

  return (
    <section aria-label={t('timeline.title')}>
      {/* New messages are announced politely to screen readers */}
      <ol role="log" aria-live="polite" aria-relevant="additions" className="space-y-3">
        {entries.map((entry) => {
          if (entry.kind === 'event') {
            const e = entry.event;
            const params = {
              field: t(`timeline.field.${e.field}`),
              from: value(e.field, e.from),
              to: value(e.field, e.to),
            };
            return (
              <li
                key={`e-${e.id}`}
                className="text-center text-xs text-slate-600 dark:text-slate-400"
              >
                {e.actor
                  ? t('timeline.changed', { ...params, actor: e.actor.name })
                  : t('timeline.changedSystem', params)}{' '}
                · <DateTime value={e.createdAt} />
              </li>
            );
          }
          const m = entry.message;
          const own = m.author.role === 'customer';
          return (
            <li
              key={`m-${m.id}`}
              data-testid={m.internal ? 'message-note' : 'message'}
              className={
                m.internal
                  ? 'rounded-md border-2 border-dashed border-amber-600 bg-amber-50 p-3 dark:border-amber-500 dark:bg-amber-950'
                  : own
                    ? 'rounded-md border border-slate-300 bg-white p-3 dark:border-slate-700 dark:bg-slate-900'
                    : 'rounded-md border border-blue-300 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-950'
              }
            >
              <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                <strong>{m.author.name}</strong>
                <DateTime value={m.createdAt} />
                {m.internal ? (
                  <span className="rounded bg-amber-700 px-1.5 py-0.5 font-semibold text-white">
                    {t('timeline.internalNote')} — {t('timeline.internalNoteHint')}
                  </span>
                ) : null}
              </div>
              <p className="whitespace-pre-wrap break-words text-sm">{m.body}</p>
              {m.attachments.length > 0 ? (
                <ul className="mt-2 flex flex-wrap gap-2" aria-label={t('timeline.attachments')}>
                  {m.attachments.map((a) => (
                    <li key={a.id}>
                      <a
                        href={`/api/attachments/${a.id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm text-blue-800 underline dark:text-blue-300"
                      >
                        📎 {a.filename}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
