'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useTimeZone } from 'next-intl';

/**
 * Stores the browser time zone in a cookie so the server renders times in the user's zone.
 * If it differs from what the server used, refresh once so SSR output matches.
 */
export function TimeZoneSync() {
  const router = useRouter();
  const serverZone = useTimeZone();
  useEffect(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const has = document.cookie.split('; ').some((c) => c === `tz=${encodeURIComponent(zone)}`);
    if (!has) {
      document.cookie = `tz=${encodeURIComponent(zone)}; path=/; max-age=31536000; samesite=lax`;
      if (zone !== serverZone) router.refresh();
    }
  }, [router, serverZone]);
  return null;
}
