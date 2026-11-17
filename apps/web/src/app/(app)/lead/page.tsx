'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import type { Stats } from '@helpdesk/shared';
import { Button, Field, inputClass } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api';
import { useMe } from '@/lib/queries';

function toDateInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysAgoInput(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return toDateInput(d);
}

function dateRangeIso(from: string, to: string): { fromIso: string; toIso: string } | null {
  if (!from || !to || from > to) return null;
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  end.setDate(end.getDate() + 1);
  return { fromIso: start.toISOString(), toIso: end.toISOString() };
}

export default function LeadDashboardPage() {
  const t = useTranslations();
  const format = useFormatter();
  const router = useRouter();
  const { data: me } = useMe();

  const [from, setFrom] = useState(() => daysAgoInput(30));
  const [to, setTo] = useState(() => daysAgoInput(0));

  useEffect(() => {
    if (me && me.role !== 'lead') {
      router.replace(me.role === 'customer' ? '/tickets' : '/queue');
    }
  }, [me, router]);

  const range = useMemo(() => dateRangeIso(from, to), [from, to]);
  const isLead = me?.role === 'lead';

  const statsQuery = useQuery({
    queryKey: ['stats', range?.fromIso, range?.toIso],
    queryFn: () => {
      if (!range) throw new Error('invalid range');
      const params = new URLSearchParams({ from: range.fromIso, to: range.toIso });
      return api<Stats>(`/stats?${params.toString()}`);
    },
    enabled: isLead && range !== null,
  });

  if (me && !isLead) return null;

  const formatHours = (minutes: number | null): string => {
    if (minutes === null) return t('common.none');
    return t('lead.hours', {
      value: format.number(minutes / 60, { maximumFractionDigits: 1 }),
    });
  };

  const stats = statsQuery.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-2xl font-semibold">{t('lead.dashboard')}</h1>

        <fieldset className="flex flex-wrap items-end gap-3">
          <legend className="sr-only">{t('lead.period')}</legend>
          <div className="flex gap-1">
            {[
              { days: 7, label: t('lead.preset7d') },
              { days: 30, label: t('lead.preset30d') },
              { days: 90, label: t('lead.preset90d') },
            ].map((p) => (
              <Button
                key={p.days}
                onClick={() => {
                  setFrom(daysAgoInput(p.days));
                  setTo(daysAgoInput(0));
                }}
              >
                {p.label}
              </Button>
            ))}
          </div>
          <Field id="stats-from" label={t('lead.from')}>
            {(props) => (
              <input
                {...props}
                type="date"
                className={`${inputClass} !w-auto`}
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                }}
              />
            )}
          </Field>
          <Field id="stats-to" label={t('lead.to')}>
            {(props) => (
              <input
                {...props}
                type="date"
                className={`${inputClass} !w-auto`}
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                }}
              />
            )}
          </Field>
        </fieldset>
      </div>

      {range === null ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {t('lead.invalidPeriod')}
        </p>
      ) : null}

      {statsQuery.isError ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {statsQuery.error instanceof ApiRequestError
            ? statsQuery.error.message
            : t('common.genericError')}
        </p>
      ) : null}

      {statsQuery.isPending && range !== null ? (
        <p className="text-sm text-slate-600 dark:text-slate-400">{t('common.loading')}</p>
      ) : null}

      {stats ? (
        <>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-md border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
              <dt className="text-sm text-slate-600 dark:text-slate-400">{t('lead.created')}</dt>
              <dd className="mt-1 text-2xl font-semibold" data-testid="stat-created">
                {format.number(stats.created)}
              </dd>
            </div>
            <div className="rounded-md border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
              <dt className="text-sm text-slate-600 dark:text-slate-400">{t('lead.resolved')}</dt>
              <dd className="mt-1 text-2xl font-semibold" data-testid="stat-resolved">
                {format.number(stats.resolved)}
              </dd>
            </div>
            <div className="rounded-md border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
              <dt className="text-sm text-slate-600 dark:text-slate-400">{t('lead.avgFirst')}</dt>
              <dd className="mt-1 text-2xl font-semibold" data-testid="stat-avg-first">
                {formatHours(stats.avgFirstResponseMinutes)}
              </dd>
            </div>
            <div className="rounded-md border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
              <dt className="text-sm text-slate-600 dark:text-slate-400">
                {t('lead.avgResolution')}
              </dt>
              <dd className="mt-1 text-2xl font-semibold" data-testid="stat-avg-resolution">
                {formatHours(stats.avgResolutionMinutes)}
              </dd>
            </div>
            <div className="rounded-md border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
              <dt className="text-sm text-slate-600 dark:text-slate-400">{t('lead.breachRate')}</dt>
              <dd className="mt-1 text-2xl font-semibold" data-testid="stat-breach-rate">
                {stats.slaBreachRate !== null
                  ? format.number(stats.slaBreachRate, {
                      style: 'percent',
                      maximumFractionDigits: 1,
                    })
                  : t('common.none')}
              </dd>
            </div>
            <div className="rounded-md border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
              <dt className="text-sm text-slate-600 dark:text-slate-400">{t('lead.avgRating')}</dt>
              <dd className="mt-1 text-2xl font-semibold" data-testid="stat-avg-rating">
                {stats.avgRating !== null ? (
                  <>
                    {format.number(stats.avgRating, { maximumFractionDigits: 2 })}{' '}
                    <span className="text-sm font-normal text-slate-600 dark:text-slate-400">
                      ({t('lead.ratingsCount', { count: stats.ratingsCount })})
                    </span>
                  </>
                ) : (
                  t('common.none')
                )}
              </dd>
            </div>
          </dl>

          <section aria-labelledby="workload-heading" className="space-y-3">
            <h2 id="workload-heading" className="text-lg font-semibold">
              {t('lead.workload')}
            </h2>
            {stats.agents.length === 0 ? (
              <p className="text-sm text-slate-600 dark:text-slate-400">{t('lead.empty')}</p>
            ) : (
              <div className="overflow-x-auto rounded-md border border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-300 bg-slate-50 dark:border-slate-700 dark:bg-slate-800">
                      <th scope="col" className="px-4 py-2.5 font-semibold">
                        {t('lead.agent')}
                      </th>
                      <th scope="col" className="px-4 py-2.5 text-right font-semibold">
                        {t('lead.openAssigned')}
                      </th>
                      <th scope="col" className="px-4 py-2.5 text-right font-semibold">
                        {t('lead.resolvedInPeriod')}
                      </th>
                      <th scope="col" className="px-4 py-2.5 text-right font-semibold">
                        {t('lead.replies')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.agents.map((a) => (
                      <tr
                        key={a.id}
                        data-testid="agent-workload-row"
                        className="border-b border-slate-200 last:border-b-0 dark:border-slate-800"
                      >
                        <td className="px-4 py-2.5 font-medium">{a.name}</td>
                        <td className="px-4 py-2.5 text-right">{format.number(a.openAssigned)}</td>
                        <td className="px-4 py-2.5 text-right">
                          {format.number(a.resolvedInPeriod)}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          {format.number(a.repliesInPeriod)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
