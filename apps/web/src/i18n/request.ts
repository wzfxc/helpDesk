import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

export const LOCALES = ['uk', 'en'] as const;
export type AppLocale = (typeof LOCALES)[number];
export const DEFAULT_TIME_ZONE = 'Europe/Kyiv';

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Locale and the user's time zone come from cookies (`locale`, `tz`). The browser writes `tz`
 * on first visit, so server rendering formats times in the same zone as the client — no
 * hydration mismatch.
 */
export default getRequestConfig(async () => {
  const store = await cookies();
  const locale: AppLocale = store.get('locale')?.value === 'en' ? 'en' : 'uk';
  const tzCookie = store.get('tz')?.value;
  const timeZone = tzCookie && isValidTimeZone(tzCookie) ? tzCookie : DEFAULT_TIME_ZONE;
  const messages = (await import(`../../messages/${locale}.json`)) as { default: object };
  return { locale, timeZone, messages: messages.default };
});
