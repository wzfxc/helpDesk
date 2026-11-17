'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Me } from '@helpdesk/shared';
import { api } from '@/lib/api';
import { useNotifications } from '@/lib/queries';
import { Button, inputClass } from './ui';

function Bell({ user }: { user: Me }) {
  const t = useTranslations('notifications');
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const staff = user.role !== 'customer';
  const { data } = useNotifications(staff);
  const panelRef = useRef<HTMLDivElement>(null);

  const markRead = useMutation({
    mutationFn: (body: { ids: string[] } | { all: true }) =>
      api('/notifications/read', { method: 'POST', json: body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!staff) return null;
  const unread = data?.unreadCount ?? 0;
  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="notifications-panel"
        aria-label={t('title')}
        onClick={() => {
          setOpen((v) => !v);
        }}
        className="relative rounded-md px-2 py-1.5 hover:bg-slate-200 dark:hover:bg-slate-800"
      >
        <span aria-hidden="true">🔔</span>
        {unread > 0 ? (
          <span
            data-testid="notifications-count"
            aria-label={t('unread', { count: unread })}
            className="ml-1 rounded-full bg-red-700 px-1.5 text-xs font-bold text-white"
          >
            {unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          id="notifications-panel"
          className="absolute right-0 z-20 mt-1 w-80 rounded-md border border-slate-300 bg-white p-2 shadow-lg dark:border-slate-600 dark:bg-slate-900"
        >
          <div className="flex items-center justify-between px-1 pb-1">
            <h2 className="text-sm font-semibold">{t('title')}</h2>
            {unread > 0 ? (
              <Button
                variant="ghost"
                onClick={() => {
                  markRead.mutate({ all: true });
                }}
              >
                {t('markAll')}
              </Button>
            ) : null}
          </div>
          {data && data.items.length > 0 ? (
            <ul className="max-h-80 overflow-auto">
              {data.items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
                    onClick={() => {
                      if (!n.readAt) markRead.mutate({ ids: [n.id] });
                      setOpen(false);
                      router.push(`/tickets/${n.ticketId}`);
                    }}
                  >
                    <span className={n.readAt ? '' : 'font-semibold'}>
                      {t(`kind.${n.kind}`, { number: `HD-${n.ticketNumber}` })}
                    </span>
                    <span className="block truncate text-xs text-slate-600 dark:text-slate-400">
                      {n.ticketSubject}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-2 py-3 text-sm text-slate-600 dark:text-slate-400">{t('empty')}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function Header({ user }: { user: Me }) {
  const t = useTranslations();
  const router = useRouter();
  const qc = useQueryClient();
  const locale = useLocale();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const logout = useMutation({
    mutationFn: () => api('/auth/logout', { method: 'POST' }),
    onSettled: () => {
      qc.clear();
      router.replace('/login');
    },
  });

  const links =
    user.role === 'customer'
      ? [
          { href: '/tickets', label: t('nav.myTickets') },
          { href: '/tickets/new', label: t('nav.newTicket') },
        ]
      : [
          { href: '/queue', label: t('nav.queue') },
          ...(user.role === 'lead'
            ? [
                { href: '/lead', label: t('nav.dashboard') },
                { href: '/lead/settings', label: t('nav.settings') },
              ]
            : []),
        ];

  return (
    <header className="border-b border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-2">
        <span className="font-semibold">{t('common.appName')}</span>
        <nav aria-label={t('nav.main')} className="flex gap-1">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="rounded-md px-2 py-1.5 text-sm hover:bg-slate-200 dark:hover:bg-slate-800"
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Bell user={user} />
          <label className="sr-only" htmlFor="lang-select">
            {t('common.language')}
          </label>
          <select
            id="lang-select"
            className={`${inputClass} !w-auto`}
            value={locale}
            onChange={(e) => {
              document.cookie = `locale=${e.target.value}; path=/; max-age=31536000; samesite=lax`;
              router.refresh();
            }}
          >
            <option value="uk">UK</option>
            <option value="en">EN</option>
          </select>
          <label className="sr-only" htmlFor="theme-select">
            {t('common.theme')}
          </label>
          <select
            id="theme-select"
            className={`${inputClass} !w-auto`}
            value={mounted ? (theme ?? 'system') : 'system'}
            onChange={(e) => {
              setTheme(e.target.value);
            }}
          >
            <option value="system">{t('common.themeSystem')}</option>
            <option value="light">{t('common.themeLight')}</option>
            <option value="dark">{t('common.themeDark')}</option>
          </select>
          <span className="hidden text-sm text-slate-700 sm:inline dark:text-slate-300">
            {user.name}
          </span>
          <Button
            onClick={() => {
              logout.mutate();
            }}
          >
            {t('common.logout')}
          </Button>
        </div>
      </div>
    </header>
  );
}
