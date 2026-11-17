'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { isUnauthorized, useMe } from '@/lib/queries';

/** Sends everyone to their home: customers to their tickets, staff to the queue. */
export default function HomePage() {
  const t = useTranslations('common');
  const router = useRouter();
  const { data: me, error } = useMe();
  useEffect(() => {
    if (me) router.replace(me.role === 'customer' ? '/tickets' : '/queue');
    else if (error && isUnauthorized(error)) router.replace('/login');
  }, [me, error, router]);
  return <main className="p-6">{t('loading')}</main>;
}
