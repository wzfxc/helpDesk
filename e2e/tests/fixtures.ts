import { randomUUID } from 'node:crypto';
import {
  test as base,
  expect,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

export { expect };

export const BASE_URL = process.env.WEB_URL ?? 'http://localhost:3000';

export interface Creds {
  email: string;
  password: string;
}
export const CUSTOMER = (n = 1): Creds => ({
  email: `customer${n.toString()}@example.com`,
  password: 'customer123',
});
export const AGENT = (n: number): Creds => ({
  email: `agent${n.toString()}@helpdesk.local`,
  password: 'agent123',
});
export const LEAD: Creds = { email: 'lead@helpdesk.local', password: 'lead123' };

/** Console/page errors that indicate a React hydration problem. */
const HYDRATION = /hydrat|did not match|text content does not match/i;

const sessions: Session[] = [];

export class Session {
  readonly hydrationErrors: string[] = [];
  readonly api: APIRequestContext;

  private constructor(
    readonly context: BrowserContext,
    readonly page: Page,
  ) {
    this.api = context.request;
    const watch = (p: Page) => {
      p.on('console', (msg) => {
        if (msg.type() === 'error' && HYDRATION.test(msg.text())) {
          this.hydrationErrors.push(msg.text());
        }
      });
      p.on('pageerror', (err) => {
        if (HYDRATION.test(err.message)) this.hydrationErrors.push(err.message);
      });
    };
    watch(page);
    context.on('page', watch);
  }

  /** New isolated browser context, English UI, logged in through the real login endpoint. */
  static async open(
    browser: Browser,
    creds: Creds,
    opts: { locale?: 'en' | 'uk'; colorScheme?: 'light' | 'dark'; timezoneId?: string } = {},
  ): Promise<Session> {
    const context = await browser.newContext({
      baseURL: BASE_URL,
      colorScheme: opts.colorScheme ?? 'light',
      timezoneId: opts.timezoneId ?? 'Europe/Kyiv',
    });
    await context.addCookies([
      { name: 'locale', value: opts.locale ?? 'en', url: BASE_URL },
      { name: 'tz', value: encodeURIComponent(opts.timezoneId ?? 'Europe/Kyiv'), url: BASE_URL },
    ]);
    const page = await context.newPage();
    const session = new Session(context, page);
    const res = await context.request.post('/api/auth/login', { data: creds });
    expect(res.status(), `login ${creds.email}`).toBe(200);
    sessions.push(session);
    return session;
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}

/** Every test fails if any session logged a hydration error; contexts are closed afterwards. */
export const test = base.extend<{ guard: boolean }>({
  guard: [
    // Playwright requires an object-destructuring first argument
    async ({ browser: _browser }, use) => {
      await use(true);
      const errors = sessions.flatMap((s) => s.hydrationErrors);
      await Promise.all(sessions.splice(0).map((s) => s.close().catch(() => undefined)));
      expect(errors, 'hydration errors in the browser console').toEqual([]);
    },
    { auto: true },
  ],
});

// ---------- API helpers ----------

export const uniqueToken = (prefix = 'E2E'): string =>
  `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();

export interface ApiTicket {
  id: string;
  number: number;
  status: string;
  priority: string;
  version: number;
}

export async function createTicketViaApi(
  api: APIRequestContext,
  opts: {
    subject: string;
    category?: string;
    priority?: string;
    body?: string;
    attachmentIds?: string[];
  },
): Promise<ApiTicket> {
  const res = await api.post('/api/tickets', {
    data: {
      subject: opts.subject,
      category: opts.category ?? 'billing',
      priority: opts.priority ?? 'normal',
      body: opts.body ?? 'Created by e2e',
      attachmentIds: opts.attachmentIds ?? [],
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as ApiTicket;
}

/** 1x1 PNG used as a valid attachment. */
export const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5d2b8e40000000049454e44ae426082',
  'hex',
);

export async function uploadViaApi(
  api: APIRequestContext,
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<{ id: string; status: number }> {
  const res = await api.post('/api/attachments', { multipart: { file } });
  const body = (await res.json().catch(() => ({}))) as { id?: string };
  return { id: body.id ?? '', status: res.status() };
}

export async function postMessageViaApi(
  api: APIRequestContext,
  ticketId: string,
  data: { body: string; internal?: boolean; attachmentIds?: string[]; clientMessageId?: string },
): Promise<void> {
  const res = await api.post(`/api/tickets/${ticketId}/messages`, {
    data: { clientMessageId: randomUUID(), internal: false, attachmentIds: [], ...data },
  });
  expect(res.status(), await res.text()).toBe(201);
}
