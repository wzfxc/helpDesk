'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CATEGORIES,
  LIMITS,
  PRIORITIES,
  STATUSES,
  type Priority,
  type Status,
  type BulkAction,
  type BulkResponse,
  type SavedView,
  type Ticket,
  type TicketListResponse,
} from '@helpdesk/shared';
import {
  PriorityBadge,
  RelativeTime,
  SlaTimer,
  StatusBadge,
  isOverdue,
} from '@/components/ticket-bits';
import { Button, inputClass } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api';
import { hotkeyAction } from '@/lib/hotkeys';
import { useMe, useViews } from '@/lib/queries';
import { flattenTickets } from '@/lib/ticket-cache';
import { useNow } from 'next-intl';

const FILTER_KEYS = [
  'status',
  'priority',
  'category',
  'assignee',
  'slaBreached',
  'slaRisk',
  'tags',
  'q',
  'sort',
] as const;

function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const t = useTranslations('queue.shortcuts');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  const rows: [string, string][] = [
    ['j', t('next')],
    ['k', t('prev')],
    ['Enter', t('open')],
    ['/', t('search')],
    ['?', t('help')],
  ];
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={t('title')}
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/50"
    >
      <div className="w-80 rounded-md bg-white p-4 shadow-xl dark:bg-slate-900">
        <h2 className="mb-2 font-semibold">{t('title')}</h2>
        <dl className="space-y-1 text-sm">
          {rows.map(([k, d]) => (
            <div key={k} className="flex justify-between">
              <dt>
                <kbd className="rounded border border-slate-400 px-1.5 font-mono">{k}</kbd>
              </dt>
              <dd>{d}</dd>
            </div>
          ))}
        </dl>
        <Button className="mt-3" onClick={onClose}>
          ✕
        </Button>
      </div>
    </div>
  );
}

function BulkReport({
  report,
  tickets,
  onClose,
}: {
  report: BulkResponse;
  tickets: Ticket[];
  onClose: () => void;
}) {
  const t = useTranslations('queue.report');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const numbers = new Map(tickets.map((x) => [x.id, x.number]));
  const skipped = report.results.flatMap((r) => (r.ok ? [] : [r]));
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={t('title')}
      data-testid="bulk-report"
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/50"
    >
      <div className="max-h-[80vh] w-[28rem] overflow-auto rounded-md bg-white p-4 shadow-xl dark:bg-slate-900">
        <h2 className="mb-2 font-semibold">{t('title')}</h2>
        <p data-testid="bulk-summary">
          {t('summary', { succeeded: report.succeeded, skipped: report.skipped })}
        </p>
        {skipped.length > 0 ? (
          <>
            <h3 className="mt-3 text-sm font-semibold">{t('skippedList')}</h3>
            <ul className="mt-1 space-y-1 text-sm">
              {skipped.map((r) => (
                <li key={r.id} data-testid="bulk-skipped">
                  {numbers.has(r.id) ? `HD-${numbers.get(r.id) ?? ''}` : r.id.slice(0, 8)} —{' '}
                  {t(`reason.${r.reason}`)}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <Button className="mt-3" variant="primary" onClick={onClose}>
          OK
        </Button>
      </div>
    </div>
  );
}

function Queue() {
  const t = useTranslations();
  const router = useRouter();
  const qc = useQueryClient();
  const params = useSearchParams();
  const { data: me } = useMe();
  const { data: views } = useViews(Boolean(me));
  const now = useNow({ updateInterval: 30_000 });
  const searchRef = useRef<HTMLInputElement>(null);

  // ----- filters live in the URL (router.push → Back works, reload restores the state) -----
  const filters = useMemo(() => {
    const out: Record<string, string> = {};
    for (const k of FILTER_KEYS) {
      const v = params.get(k);
      if (v) out[k] = v;
    }
    return out;
  }, [params]);
  const queryString = new URLSearchParams(filters).toString();
  const setFilter = useCallback(
    (patch: Record<string, string | undefined>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      router.push(`/queue${next.toString() ? `?${next.toString()}` : ''}`);
    },
    [params, router],
  );

  const [search, setSearch] = useState(filters.q ?? '');
  useEffect(() => {
    setSearch(filters.q ?? '');
  }, [filters.q]);
  useEffect(() => {
    if (search === (filters.q ?? '')) return;
    const timer = setTimeout(() => {
      setFilter({ q: search.trim() || undefined });
    }, 400);
    return () => {
      clearTimeout(timer);
    };
  }, [search, filters.q, setFilter]);

  const list = useInfiniteQuery({
    queryKey: ['tickets', 'queue', queryString],
    queryFn: ({ pageParam }) =>
      api<TicketListResponse>(
        `/tickets?${queryString}${queryString ? '&' : ''}limit=50${pageParam ? `&cursor=${pageParam}` : ''}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: Boolean(me),
  });
  const tickets = flattenTickets(list.data);

  // ----- selection, keyboard cursor -----
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [active, setActive] = useState(-1);
  const [help, setHelp] = useState(false);
  const [report, setReport] = useState<BulkResponse | null>(null);
  const ticketsRef = useRef(tickets);
  ticketsRef.current = tickets;
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = hotkeyAction(e);
      if (!action) return;
      const rows = ticketsRef.current;
      if (action === 'next') {
        e.preventDefault();
        setActive((i) => Math.min(rows.length - 1, i + 1));
      } else if (action === 'prev') {
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
      } else if (action === 'open') {
        const row = rows[activeRef.current];
        if (row) {
          e.preventDefault();
          router.push(`/tickets/${row.id}`);
        }
      } else if (action === 'search') {
        e.preventDefault();
        searchRef.current?.focus();
      } else {
        e.preventDefault();
        setHelp(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [router]);

  useEffect(() => {
    document
      .querySelector(`[data-row-index="${active.toString()}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  // ----- take next -----
  const [message, setMessage] = useState<string | null>(null);
  const takeNext = useMutation({
    mutationFn: () => api<Ticket>('/tickets/take-next', { method: 'POST' }),
    onSuccess: (ticket) => {
      setMessage(null);
      void qc.invalidateQueries({ queryKey: ['tickets'] });
      router.push(`/tickets/${ticket.id}`);
    },
    onError: (err) => {
      setMessage(
        err instanceof ApiRequestError && err.code === 'no_tickets_available'
          ? t('queue.noneAvailable')
          : t('common.genericError'),
      );
    },
  });

  // ----- bulk -----
  const [bulkChoice, setBulkChoice] = useState('');
  const [bulkTag, setBulkTag] = useState('');
  const bulk = useMutation({
    mutationFn: (action: BulkAction) =>
      api<BulkResponse>('/tickets/bulk', { method: 'POST', json: { ids: [...selected], action } }),
    onSuccess: (res) => {
      setReport(res);
      // keep only skipped tickets selected so the user can see/adjust them
      setSelected(new Set(res.results.flatMap((r) => (r.ok ? [] : [r.id]))));
      void qc.invalidateQueries({ queryKey: ['tickets'] });
    },
  });
  const toBulkAction = (): BulkAction | null => {
    const [kind, value] = bulkChoice.split(':');
    if (!me) return null;
    if (kind === 'assign') return { type: 'assign', assigneeId: value === 'me' ? me.id : null };
    if (kind === 'status' && value) return { type: 'status', status: value as Status };
    if (kind === 'priority' && value) return { type: 'priority', priority: value as Priority };
    if (kind === 'tag' && bulkTag.trim())
      return { type: 'tags', add: [bulkTag.trim()], remove: [] };
    return null;
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < LIMITS.bulkMax) next.add(id);
      return next;
    });
  };
  const allSelected = tickets.length > 0 && tickets.every((x) => selected.has(x.id));
  const applyView = (v: SavedView) => {
    router.push(`/queue?${v.query}`);
  };

  const [viewName, setViewName] = useState('');
  const saveView = useMutation({
    mutationFn: () =>
      api<SavedView>('/views', { method: 'POST', json: { name: viewName, query: queryString } }),
    onSuccess: () => {
      setViewName('');
      void qc.invalidateQueries({ queryKey: ['views'] });
    },
  });
  const deleteView = useMutation({
    mutationFn: (id: string) => api(`/views/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['views'] }),
  });

  if (!me) return null;
  const select = `${inputClass} !w-auto`;
  const bulkAction = toBulkAction();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{t('queue.title')}</h1>
        <Button
          variant="primary"
          disabled={takeNext.isPending}
          onClick={() => {
            takeNext.mutate();
          }}
        >
          {t('queue.takeNext')}
        </Button>
        <Button
          variant="ghost"
          aria-label={t('queue.shortcuts.title')}
          onClick={() => {
            setHelp(true);
          }}
        >
          ?
        </Button>
        {message ? (
          <p role="status" data-testid="queue-message">
            {message}
          </p>
        ) : null}
      </div>

      <nav aria-label={t('queue.views')} className="flex flex-wrap items-center gap-2">
        {views?.map((v) => (
          <span key={v.id} className="inline-flex items-center">
            <Button
              variant={v.query === queryString ? 'primary' : 'secondary'}
              onClick={() => {
                applyView(v);
              }}
            >
              {v.builtIn ? t(`queue.view.${v.name}`) : v.name}
            </Button>
            {!v.builtIn ? (
              <Button
                variant="ghost"
                aria-label={`${t('common.delete')}: ${v.name}`}
                onClick={() => {
                  deleteView.mutate(v.id);
                }}
              >
                ✕
              </Button>
            ) : null}
          </span>
        ))}
        <span className="ml-auto flex items-center gap-1">
          <label htmlFor="view-name" className="sr-only">
            {t('queue.viewName')}
          </label>
          <input
            id="view-name"
            className={`${inputClass} !w-40`}
            placeholder={t('queue.viewName')}
            value={viewName}
            onChange={(e) => {
              setViewName(e.target.value);
            }}
          />
          <Button
            disabled={!viewName.trim() || !queryString || saveView.isPending}
            onClick={() => {
              saveView.mutate();
            }}
          >
            {t('queue.saveView')}
          </Button>
        </span>
      </nav>

      <form
        role="search"
        aria-label={t('queue.filters')}
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setFilter({ q: search.trim() || undefined });
        }}
      >
        <div>
          <label htmlFor="q" className="sr-only">
            {t('queue.search')}
          </label>
          <input
            id="q"
            ref={searchRef}
            type="search"
            className={`${inputClass} !w-64`}
            placeholder={t('queue.searchPlaceholder')}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
            }}
          />
        </div>
        <label className="sr-only" htmlFor="f-status">
          {t('queue.status')}
        </label>
        <select
          id="f-status"
          className={select}
          value={filters.status ?? ''}
          onChange={(e) => {
            setFilter({ status: e.target.value || undefined });
          }}
        >
          <option value="">{t('queue.allStatuses')}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`status.${s}`)}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="f-priority">
          {t('queue.priority')}
        </label>
        <select
          id="f-priority"
          className={select}
          value={filters.priority ?? ''}
          onChange={(e) => {
            setFilter({ priority: e.target.value || undefined });
          }}
        >
          <option value="">{t('queue.allPriorities')}</option>
          {PRIORITIES.map((s) => (
            <option key={s} value={s}>
              {t(`priority.${s}`)}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="f-category">
          {t('queue.category')}
        </label>
        <select
          id="f-category"
          className={select}
          value={filters.category ?? ''}
          onChange={(e) => {
            setFilter({ category: e.target.value || undefined });
          }}
        >
          <option value="">{t('queue.allCategories')}</option>
          {CATEGORIES.map((s) => (
            <option key={s} value={s}>
              {t(`category.${s}`)}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="f-assignee">
          {t('queue.assignee')}
        </label>
        <select
          id="f-assignee"
          className={select}
          value={filters.assignee ?? ''}
          onChange={(e) => {
            setFilter({ assignee: e.target.value || undefined });
          }}
        >
          <option value="">{t('queue.assigneeAny')}</option>
          <option value="me">{t('queue.assigneeMe')}</option>
          <option value="none">{t('queue.assigneeNone')}</option>
        </select>
        <label className="flex items-center gap-1 text-sm">
          <input
            type="checkbox"
            checked={filters.slaBreached === 'true'}
            onChange={(e) => {
              setFilter({ slaBreached: e.target.checked ? 'true' : undefined });
            }}
          />
          {t('queue.slaBreachedOnly')}
        </label>
        <label className="sr-only" htmlFor="f-sort">
          {t('queue.sort')}
        </label>
        <select
          id="f-sort"
          className={select}
          value={filters.sort ?? 'sla'}
          onChange={(e) => {
            setFilter({ sort: e.target.value === 'sla' ? undefined : e.target.value });
          }}
        >
          <option value="sla">{t('queue.sortSla')}</option>
          <option value="-created">{t('queue.sortCreated')}</option>
          <option value="-updated">{t('queue.sortUpdated')}</option>
        </select>
        {queryString ? (
          <Button
            onClick={() => {
              router.push('/queue');
            }}
          >
            {t('queue.reset')}
          </Button>
        ) : null}
      </form>

      {selected.size > 0 ? (
        <div
          role="region"
          aria-label={t('queue.bulkAction')}
          className="flex flex-wrap items-center gap-2 rounded-md border border-blue-600 bg-blue-50 p-2 dark:bg-blue-950"
        >
          <strong data-testid="selected-count">
            {t('queue.selected', { count: selected.size })}
          </strong>
          <label htmlFor="bulk-select" className="sr-only">
            {t('queue.bulkAction')}
          </label>
          <select
            id="bulk-select"
            className={select}
            value={bulkChoice}
            onChange={(e) => {
              setBulkChoice(e.target.value);
            }}
          >
            <option value="">{t('queue.bulkAction')}…</option>
            <option value="assign:me">{t('queue.bulkAssignMe')}</option>
            {me.role === 'lead' ? (
              <option value="assign:none">{t('queue.bulkUnassign')}</option>
            ) : null}
            {STATUSES.filter((s) => s !== 'new').map((s) => (
              <option key={s} value={`status:${s}`}>
                {t('queue.bulkStatus')} {t(`status.${s}`)}
              </option>
            ))}
            {PRIORITIES.map((p) => (
              <option key={p} value={`priority:${p}`}>
                {t('queue.bulkPriority')} {t(`priority.${p}`)}
              </option>
            ))}
            <option value="tag:add">{t('queue.bulkAddTag')}</option>
          </select>
          {bulkChoice === 'tag:add' ? (
            <>
              <label htmlFor="bulk-tag" className="sr-only">
                {t('queue.bulkTagPlaceholder')}
              </label>
              <input
                id="bulk-tag"
                className={`${inputClass} !w-32`}
                placeholder={t('queue.bulkTagPlaceholder')}
                value={bulkTag}
                onChange={(e) => {
                  setBulkTag(e.target.value);
                }}
              />
            </>
          ) : null}
          <Button
            variant="primary"
            disabled={!bulkAction || bulk.isPending}
            onClick={() => {
              if (bulkAction) bulk.mutate(bulkAction);
            }}
          >
            {t('common.apply')}
          </Button>
          <Button
            onClick={() => {
              setSelected(new Set());
            }}
          >
            {t('queue.clearSelection')}
          </Button>
          {selected.size >= LIMITS.bulkMax ? (
            <span role="status">{t('queue.bulkTooMany', { max: LIMITS.bulkMax })}</span>
          ) : null}
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-md border border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-300 bg-slate-100 dark:border-slate-700 dark:bg-slate-800">
            <tr>
              <th scope="col" className="w-8 p-2">
                <input
                  type="checkbox"
                  aria-label={t('queue.selectAll')}
                  checked={allSelected}
                  onChange={() => {
                    setSelected(
                      allSelected
                        ? new Set()
                        : new Set(tickets.slice(0, LIMITS.bulkMax).map((x) => x.id)),
                    );
                  }}
                />
              </th>
              <th scope="col" className="p-2">
                {t('queue.number')}
              </th>
              <th scope="col" className="p-2">
                {t('queue.subject')}
              </th>
              <th scope="col" className="p-2">
                {t('queue.status')}
              </th>
              <th scope="col" className="p-2">
                {t('queue.priority')}
              </th>
              <th scope="col" className="p-2">
                {t('queue.assignee')}
              </th>
              <th scope="col" className="p-2">
                {t('queue.sla')}
              </th>
              <th scope="col" className="p-2">
                {t('queue.updated')}
              </th>
            </tr>
          </thead>
          <tbody>
            {tickets.map((ticket, i) => {
              const overdue = isOverdue(ticket, now.getTime());
              return (
                <tr
                  key={ticket.id}
                  data-row-index={i}
                  data-testid="queue-row"
                  data-active={i === active}
                  className={`border-b border-slate-200 dark:border-slate-800 ${
                    overdue ? 'bg-red-50 dark:bg-red-950' : ''
                  } ${i === active ? 'outline outline-2 -outline-offset-2 outline-blue-600' : ''}`}
                >
                  <td className="p-2">
                    <input
                      type="checkbox"
                      aria-label={t('queue.selectRow', { number: `HD-${ticket.number}` })}
                      checked={selected.has(ticket.id)}
                      onChange={() => {
                        toggle(ticket.id);
                      }}
                    />
                  </td>
                  <td className="p-2 font-mono">HD-{ticket.number}</td>
                  <td className="p-2">
                    <Link
                      href={`/tickets/${ticket.id}`}
                      aria-current={i === active ? 'true' : undefined}
                      className="underline"
                    >
                      {ticket.subject}
                    </Link>
                    {ticket.unread ? (
                      <span
                        className="ml-2 inline-block h-2 w-2 rounded-full bg-blue-600"
                        aria-hidden="true"
                      />
                    ) : null}
                  </td>
                  <td className="p-2">
                    <StatusBadge status={ticket.status} />
                  </td>
                  <td className="p-2">
                    <PriorityBadge priority={ticket.priority} />
                  </td>
                  <td className="p-2">{ticket.assignee?.name ?? t('ticket.unassigned')}</td>
                  <td className="p-2">
                    <SlaTimer ticket={ticket} />
                  </td>
                  <td className="p-2">
                    <RelativeTime value={ticket.updatedAt} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {list.isSuccess && tickets.length === 0 ? <p className="p-4">{t('queue.empty')}</p> : null}
      </div>
      {list.hasNextPage ? (
        <Button
          disabled={list.isFetchingNextPage}
          onClick={() => {
            void list.fetchNextPage();
          }}
        >
          {t('common.loadMore')}
        </Button>
      ) : null}
      {help ? (
        <ShortcutsHelp
          onClose={() => {
            setHelp(false);
          }}
        />
      ) : null}
      {report ? (
        <BulkReport
          report={report}
          tickets={tickets}
          onClose={() => {
            setReport(null);
          }}
        />
      ) : null}
    </div>
  );
}

export default function QueuePage() {
  // useSearchParams needs a Suspense boundary during prerendering
  return (
    <Suspense fallback={null}>
      <Queue />
    </Suspense>
  );
}
