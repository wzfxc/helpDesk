'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Me, Ticket, TicketDetail } from '@helpdesk/shared';
import { Composer } from '@/components/composer';
import { SidePanel } from '@/components/side-panel';
import { PriorityBadge, StatusBadge } from '@/components/ticket-bits';
import { Timeline } from '@/components/timeline';
import { Button, inputClass } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api';
import { useMe, useStaff } from '@/lib/queries';
import { replaceTicket } from '@/lib/ticket-cache';

function RatingForm({ ticket }: { ticket: Ticket }) {
  const t = useTranslations('ticket');
  const qc = useQueryClient();
  const [score, setScore] = useState(5);
  const [comment, setComment] = useState('');
  const rate = useMutation({
    mutationFn: () =>
      api<Ticket>(`/tickets/${ticket.id}/rating`, {
        method: 'POST',
        json: { score, comment: comment || undefined },
      }),
    onSuccess: (updated) => {
      qc.setQueryData<TicketDetail>(['ticket', ticket.id], (d) => replaceTicket(d, updated));
    },
  });
  if (ticket.rating) {
    return (
      <p className="text-sm" data-testid="rating-thanks">
        {t('ratingThanks')} — {t('rating', { score: ticket.rating.score })}
      </p>
    );
  }
  return (
    <form
      className="space-y-2 rounded-md border border-slate-300 bg-white p-3 dark:border-slate-700 dark:bg-slate-900"
      onSubmit={(e) => {
        e.preventDefault();
        rate.mutate();
      }}
    >
      <fieldset>
        <legend className="text-sm font-medium">{t('rateTitle')}</legend>
        <div className="flex gap-3">
          {[1, 2, 3, 4, 5].map((n) => (
            <label key={n} className="flex items-center gap-1 text-sm">
              <input
                type="radio"
                name="score"
                value={n}
                checked={score === n}
                onChange={() => {
                  setScore(n);
                }}
              />
              {n}
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <label htmlFor="rating-comment" className="text-sm">
          {t('ratingComment')}
        </label>
        <textarea
          id="rating-comment"
          className={inputClass}
          rows={2}
          value={comment}
          onChange={(e) => {
            setComment(e.target.value);
          }}
        />
      </div>
      <Button type="submit" variant="primary" disabled={rate.isPending}>
        {t('ratingSubmit')}
      </Button>
    </form>
  );
}

function TicketView({ id, me }: { id: string; me: Me }) {
  const t = useTranslations('ticket');
  const qc = useQueryClient();
  const staff = me.role !== 'customer';
  const { data: staffList } = useStaff(staff);
  const query = useQuery({
    queryKey: ['ticket', id],
    queryFn: () => api<TicketDetail>(`/tickets/${id}`),
    retry: false,
  });
  const detail = query.data;
  const count = detail?.messages.length ?? 0;

  // Opening (or receiving a message in) the ticket marks it as read.
  useEffect(() => {
    if (!detail) return;
    void api(`/tickets/${id}/read`, { method: 'POST' })
      .then(() => qc.invalidateQueries({ queryKey: ['tickets'], refetchType: 'none' }))
      .catch(() => undefined);
  }, [id, count, detail === undefined, qc]); // eslint-disable-line react-hooks/exhaustive-deps -- only the message count and presence matter

  const solve = useMutation({
    mutationFn: () => api<Ticket>(`/tickets/${id}/resolve`, { method: 'POST' }),
    onSuccess: (updated) => {
      qc.setQueryData<TicketDetail>(['ticket', id], (d) => replaceTicket(d, updated));
    },
  });

  if (query.error instanceof ApiRequestError && query.error.status === 404) {
    return <p role="alert">{t('notFound')}</p>;
  }
  if (!detail) return null;
  const { ticket } = detail;
  const canSolve = !staff && ['new', 'open', 'pending'].includes(ticket.status);

  return (
    <div className={staff ? 'grid gap-6 lg:grid-cols-[1fr_22rem]' : 'max-w-3xl'}>
      <div className="space-y-4">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">
            <span className="font-mono text-lg">HD-{ticket.number}</span> {ticket.subject}
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={ticket.status} />
            <PriorityBadge priority={ticket.priority} />
            {ticket.parentTicketId ? (
              <Link href={`/tickets/${ticket.parentTicketId}`} className="text-sm underline">
                {t('followUpOf', { number: `HD-${ticket.parentTicketNumber ?? ''}` })}
              </Link>
            ) : null}
          </div>
        </header>
        {canSolve ? (
          <Button
            variant="primary"
            disabled={solve.isPending}
            onClick={() => {
              solve.mutate();
            }}
          >
            {t('markSolved')}
          </Button>
        ) : null}
        {!staff && (ticket.status === 'resolved' || ticket.status === 'closed') ? (
          <RatingForm ticket={ticket} />
        ) : null}
        <Timeline messages={detail.messages} events={detail.events} staff={staffList} />
        {!staff && ticket.status === 'closed' ? (
          <p className="text-sm" role="status">
            {t('closedNotice')}
          </p>
        ) : null}
        <Composer ticket={ticket} me={me} />
      </div>
      {staff ? <SidePanel ticket={ticket} me={me} /> : null}
    </div>
  );
}

export default function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: me } = useMe();
  if (!me) return null;
  return <TicketView key={id} id={id} me={me} />;
}
