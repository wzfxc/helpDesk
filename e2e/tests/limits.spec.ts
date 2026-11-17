import { expect } from '@playwright/test';
import { CUSTOMER, Session, test } from './fixtures';

/**
 * Limits through the real Next.js proxy (web:3000 -> api:4000). The reviewer's concern: the
 * proxy's own body-size handling must not turn a clean 413 into a 500 or a dropped connection.
 */
const MIB = 1024 * 1024;
const ATTACHMENT_MAX = 10 * MIB; // packages/shared LIMITS.attachmentMaxBytes

const upload = (session: Session, bytes: number) =>
  session.api.post('/api/attachments', {
    multipart: {
      file: { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.alloc(bytes, 0x61) },
    },
  });

test('attachment of exactly 10 MiB passes through the proxy', async ({ browser }) => {
  const s = await Session.open(browser, CUSTOMER(11));
  const res = await upload(s, ATTACHMENT_MAX);
  expect(res.status(), await res.text()).toBe(201);
  expect(((await res.json()) as { size: number }).size).toBe(ATTACHMENT_MAX);
});

for (const [label, bytes] of [
  ['10 MiB + 1 byte', ATTACHMENT_MAX + 1],
  ['11 MiB', 11 * MIB],
  ['30 MiB (above the proxy buffer)', 30 * MIB],
] as const) {
  test(`${label} is a clean 413 in the unified error format`, async ({ browser }) => {
    const s = await Session.open(browser, CUSTOMER(12));
    const res = await upload(s, bytes);
    expect(res.status()).toBe(413);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('payload_too_large');
  });
}

test('JSON bodies above 256 KB are 413 through the proxy', async ({ browser }) => {
  const s = await Session.open(browser, CUSTOMER(13));
  const res = await s.api.post('/api/tickets', {
    data: {
      subject: 's',
      category: 'billing',
      priority: 'low',
      body: 'x'.repeat(256 * 1024 + 1),
    },
  });
  expect(res.status()).toBe(413);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe('payload_too_large');
});
