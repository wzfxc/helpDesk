'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Header } from '@/components/header';
import { isUnauthorized, useMe } from '@/lib/queries';
import { useEventStream } from '@/lib/use-event-stream';

/** Everything inside (app) needs a session; one SSE connection serves all pages. */
export default function AppLayout({ children }: { children: ReactNode }) {
  const t = useTranslations('common');
  const router = useRouter();
  const { data: me, error } = useMe();
  useEventStream(Boolean(me));
  useEffect(() => {
    if (error && isUnauthorized(error)) router.replace('/login');
  }, [error, router]);

  if (!me) return <main className="p-6">{t('loading')}</main>;
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:p-2 focus:text-black"
      >
        {t('skipToContent')}
      </a>
      <Header user={me} />
      <main id="main" tabIndex={-1} className="mx-auto max-w-7xl px-4 py-6">
        {children}
      </main>
    </>
  );
}
