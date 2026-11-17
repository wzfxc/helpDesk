import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTimeZone } from 'next-intl/server';
import { Providers } from '@/components/providers';
import { TimeZoneSync } from '@/components/time-zone-sync';
import './globals.css';

export const metadata: Metadata = { title: 'Helpdesk' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [locale, messages, timeZone] = await Promise.all([
    getLocale(),
    getMessages(),
    getTimeZone(),
  ]);
  return (
    // suppressHydrationWarning: next-themes sets the theme class on <html> before hydration
    <html lang={locale} suppressHydrationWarning>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages} timeZone={timeZone}>
          <Providers>
            <TimeZoneSync />
            {children}
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
