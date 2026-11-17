'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { TicketListResponse } from '@helpdesk/shared';
import { PriorityBadge, RelativeTime, StatusBadge } from '@/components/ticket-bits';
import { Button } from '@/components/ui';
import { api } from '@/lib/api';
import { useMe } from '@/lib/queries';
import { flattenTickets } from '@/lib/ticket-cache';

export default function MyTicketsPage() {
  const t = useTranslations();
  const router = useRouter();
  const { data: me } = useMe();
  useEffect(() => {
    if (me && me.role !== 'customer') router.replace('/queue');
  }, [me, router]);

  const list = useInfiniteQuery({
    queryKey: ['tickets', 'mine'],
    queryFn: ({ pageParam }) =>
      api<TicketListResponse>(`/tickets?limit=30${pageParam ? `&cursor=${pageParam}` : ''}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: me?.role === 'customer',
  });
  const tickets = flattenTickets(list.data);

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">{t('customer.title')}</h1>
      {list.isSuccess && tickets.length === 0 ? <p>{t('customer.empty')}</p> : null}
      <ul className="space-y-2">
        {tickets.map((ticket) => (
          <li key={ticket.id}>
            <Link
              href={`/tickets/${ticket.id}`}
              data-unread={ticket.unread}
              className={`flex flex-wrap items-center gap-3 rounded-md border p-3 hover:bg-slate-100 dark:hover:bg-slate-800 ${
                ticket.unread
                  ? 'border-blue-600 bg-blue-50 dark:border-blue-400 dark:bg-blue-950'
                  : 'border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900'
              }`}
            >
              <span className="font-mono text-sm">HD-{ticket.number}</span>
              <span className={ticket.unread ? 'font-semibold' : ''}>{ticket.subject}</span>
              <StatusBadge status={ticket.status} />
              {ticket.unread ? (
                <span className="rounded bg-blue-700 px-2 py-0.5 text-xs font-semibold text-white dark:bg-blue-500">
                  {t('customer.unread')}
                </span>
              ) : null}
              <span className="ml-auto text-sm text-slate-600 dark:text-slate-400">
                <PriorityBadge priority={ticket.priority} />{' '}
                <RelativeTime value={ticket.updatedAt} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {list.hasNextPage ? (
        <Button
          className="mt-4"
          disabled={list.isFetchingNextPage}
          onClick={() => {
            void list.fetchNextPage();
          }}
        >
          {t('common.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}
