'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CATEGORIES,
  PRIORITIES,
  manualTargets,
  type Category,
  type Me,
  type Priority,
  type Status,
  type Ticket,
  type TicketDetail,
  type UpdateTicket,
} from '@helpdesk/shared';
import { api, ApiRequestError } from '@/lib/api';
import { useStaff } from '@/lib/queries';
import { replaceTicket } from '@/lib/ticket-cache';
import { DateTime, SlaTimer } from './ticket-bits';
import { Button, inputClass } from './ui';

type Changes = Partial<
  Pick<UpdateTicket, 'status' | 'priority' | 'category' | 'assigneeId' | 'tags'>
>;

/** Ticket properties editor with optimistic locking: a 409 loads the current state and keeps the attempted change. */
export function SidePanel({ ticket, me }: { ticket: Ticket; me: Me }) {
  const t = useTranslations();
  const qc = useQueryClient();
  const lead = me.role === 'lead';
  const { data: staff } = useStaff(lead);
  const [conflict, setConflict] = useState<Changes | null>(null);
  const [tagText, setTagText] = useState<string | null>(null);
  const closed = ticket.status === 'closed';

  const patch = useMutation({
    mutationFn: (changes: Changes) =>
      api<Ticket>(`/tickets/${ticket.id}`, {
        method: 'PATCH',
        json: { version: ticket.version, ...changes },
      }),
    onSuccess: (updated) => {
      setConflict(null);
      setTagText(null);
      qc.setQueryData<TicketDetail>(['ticket', ticket.id], (d) => replaceTicket(d, updated));
      void qc.invalidateQueries({ queryKey: ['ticket', ticket.id] });
    },
    onError: (err, changes) => {
      if (err instanceof ApiRequestError && err.status === 409) {
        const current = (err.body as { current?: Ticket }).current;
        if (current) {
          qc.setQueryData<TicketDetail>(['ticket', ticket.id], (d) => replaceTicket(d, current));
        }
        setConflict(changes);
        setTagText(null);
      }
    },
  });

  const statuses: Status[] = [ticket.status, ...manualTargets(ticket.status)];
  const describe = (c: Changes): string =>
    Object.entries(c)
      .map(([k, v]) => {
        const value = Array.isArray(v)
          ? v.join(', ')
          : typeof v === 'string'
            ? k === 'status' || k === 'priority' || k === 'category'
              ? t(`${k}.${v}`)
              : (staff?.find((s) => s.id === v)?.name ?? v)
            : t('ticket.unassigned');
        return `${t(`ticket.${k === 'assigneeId' ? 'assignee' : k}`)}: ${value}`;
      })
      .join('; ');

  const row = 'grid grid-cols-[7rem_1fr] items-center gap-2 text-sm';
  return (
    <aside
      aria-label={t('ticket.details')}
      className="space-y-3 rounded-md border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
    >
      {conflict ? (
        <div
          role="alert"
          data-testid="conflict-banner"
          className="space-y-2 rounded border-2 border-red-600 bg-red-50 p-3 text-sm dark:bg-red-950"
        >
          <p className="font-semibold">{t('conflict.title')}</p>
          <p>
            {t('conflict.body')} <em>{describe(conflict)}</em>
          </p>
          <div className="flex gap-2">
            <Button
              variant="primary"
              onClick={() => {
                patch.mutate(conflict);
              }}
            >
              {t('conflict.reapply')}
            </Button>
            <Button
              onClick={() => {
                setConflict(null);
              }}
            >
              {t('conflict.dismiss')}
            </Button>
          </div>
        </div>
      ) : null}

      {closed ? (
        <p id="sp-closed-note" className="text-sm text-slate-700 dark:text-slate-300">
          {t('ticket.closedReadonly')}
        </p>
      ) : null}

      <div className={row}>
        <label htmlFor="sp-status">{t('ticket.status')}</label>
        <select
          id="sp-status"
          className={inputClass}
          value={ticket.status}
          disabled={closed || patch.isPending}
          aria-describedby={closed ? 'sp-closed-note' : undefined}
          onChange={(e) => {
            patch.mutate({ status: e.target.value as Status });
          }}
        >
          {statuses.map((s) => (
            <option key={s} value={s}>
              {t(`status.${s}`)}
            </option>
          ))}
        </select>
      </div>
      <div className={row}>
        <label htmlFor="sp-priority">{t('ticket.priority')}</label>
        <select
          id="sp-priority"
          className={inputClass}
          value={ticket.priority}
          disabled={closed || patch.isPending}
          aria-describedby={closed ? 'sp-closed-note' : undefined}
          onChange={(e) => {
            patch.mutate({ priority: e.target.value as Priority });
          }}
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {t(`priority.${p}`)}
            </option>
          ))}
        </select>
      </div>
      <div className={row}>
        <label htmlFor="sp-category">{t('ticket.category')}</label>
        <select
          id="sp-category"
          className={inputClass}
          value={ticket.category}
          disabled={closed || patch.isPending}
          aria-describedby={closed ? 'sp-closed-note' : undefined}
          onChange={(e) => {
            patch.mutate({ category: e.target.value as Category });
          }}
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(`category.${c}`)}
            </option>
          ))}
        </select>
      </div>
      <div className={row}>
        <label htmlFor="sp-assignee">{t('ticket.assignee')}</label>
        {lead ? (
          <select
            id="sp-assignee"
            className={inputClass}
            value={ticket.assignee?.id ?? ''}
            disabled={closed || patch.isPending}
            aria-describedby={closed ? 'sp-closed-note' : undefined}
            onChange={(e) => {
              patch.mutate({ assigneeId: e.target.value || null });
            }}
          >
            <option value="">{t('ticket.unassigned')}</option>
            {staff?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        ) : (
          <div className="flex items-center gap-2">
            <span id="sp-assignee">{ticket.assignee?.name ?? t('ticket.unassigned')}</span>
            {!closed && !ticket.assignee ? (
              <Button
                disabled={patch.isPending}
                onClick={() => {
                  patch.mutate({ assigneeId: me.id });
                }}
              >
                {t('ticket.assignToMe')}
              </Button>
            ) : null}
          </div>
        )}
      </div>
      <div className={row}>
        <label htmlFor="sp-tags">{t('ticket.tags')}</label>
        <input
          id="sp-tags"
          className={inputClass}
          disabled={closed}
          aria-describedby={closed ? 'sp-closed-note sp-tags-hint' : 'sp-tags-hint'}
          value={tagText ?? ticket.tags.join(', ')}
          onChange={(e) => {
            setTagText(e.target.value);
          }}
          onBlur={() => {
            if (tagText === null) return;
            const tags = tagText
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean);
            if (tags.join(',') !== ticket.tags.join(',')) patch.mutate({ tags });
            else setTagText(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
        <span id="sp-tags-hint" className="sr-only">
          {t('ticket.tagsHint')}
        </span>
      </div>
      {patch.isError && !(patch.error instanceof ApiRequestError && patch.error.status === 409) ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {patch.error instanceof ApiRequestError && patch.error.status === 422
            ? patch.error.message
            : t('common.genericError')}
        </p>
      ) : null}

      <dl className="space-y-1 border-t border-slate-300 pt-3 text-sm dark:border-slate-700">
        <div className="flex justify-between gap-2">
          <dt>{t('ticket.customer')}</dt>
          <dd>{ticket.customer.name}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>{t('ticket.sla')}</dt>
          <dd data-testid="sla-timer">
            <SlaTimer ticket={ticket} />
          </dd>
        </div>
        {ticket.firstResponseDueAt ? (
          <div className="flex justify-between gap-2">
            <dt>{t('ticket.firstResponse')}</dt>
            <dd>
              <DateTime value={ticket.firstResponseDueAt} />
            </dd>
          </div>
        ) : null}
        {ticket.resolutionDueAt ? (
          <div className="flex justify-between gap-2">
            <dt>{t('ticket.resolution')}</dt>
            <dd>
              <DateTime value={ticket.resolutionDueAt} />
            </dd>
          </div>
        ) : null}
      </dl>
    </aside>
  );
}
