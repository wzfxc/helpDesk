import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from './app.js';
import { resetDb } from './db.js';
import { createTicket, createWorld, type World } from './fixtures.js';

let ctx: TestContext;
let w: World;
beforeAll(async () => {
  ctx = await createTestApp();
});
beforeEach(async () => {
  await resetDb(ctx.pool);
  w = await createWorld(ctx);
});
afterAll(async () => {
  await ctx.close();
});

const BAD_BODIES: unknown[] = [
  undefined,
  null,
  [],
  'string',
  42,
  {},
  { version: 'x' },
  { ids: 'x', action: 5 },
  { ids: [null], action: {} },
  { subject: 'x'.repeat(10_000), category: {}, priority: [], body: 1 },
  { version: 1e308, status: {}, tags: [[]] },
  { clientMessageId: 'x', body: null },
  { __proto__: { admin: true }, constructor: { prototype: {} } },
  { policies: [{ priority: 'low' }] },
  { from: 'a', to: 'b' },
  { ids: [randomUUID()], action: { type: 'tags', add: [{}], remove: 'x' } },
  { score: 'five' },
  { name: 1, query: 2 },
  { email: {}, password: [] },
];
const BAD_IDS = ['not-a-uuid', '%00', '..%2F..%2Fetc%2Fpasswd', 'x'.repeat(5000), '0'];
const BAD_QUERIES = [
  '?status[]=x',
  '?status=%00',
  '?limit=NaN',
  '?limit=-1',
  '?cursor=%ZZ',
  '?q=%27%3B%20drop%20table',
  '?tags=%00',
  '?createdFrom=9999999999999',
  '?sort=-',
  '?assignee=%00',
  `?cursor=${'A'.repeat(5000)}`,
  '?status=open&status=bogus',
  '?from=&to=',
];

describe('no 5xx on malformed input', () => {
  it('bodies', async () => {
    const t = await createTicket(w.as.customer);
    const targets: [string, string][] = [
      ['post', '/auth/login'],
      ['post', '/tickets'],
      ['patch', `/tickets/${t.id}`],
      ['post', `/tickets/${t.id}/messages`],
      ['post', `/tickets/${t.id}/rating`],
      ['post', '/tickets/bulk'],
      ['post', '/notifications/read'],
      ['post', '/canned-responses'],
      ['put', `/canned-responses/${randomUUID()}`],
      ['post', '/views'],
      ['put', '/sla-policies'],
    ];
    for (const agent of [w.as.customer, w.as.billingAgent, w.as.lead]) {
      for (const [method, url] of targets) {
        for (const body of BAD_BODIES) {
          const req = agent[method as 'post' | 'patch' | 'put'](url);
          const res =
            body === undefined
              ? await req
              : await req.set('Content-Type', 'application/json').send(JSON.stringify(body));
          expect(res.status, `${method} ${url} ${JSON.stringify(body)}`).toBeLessThan(500);
          expect(res.status).toBeGreaterThanOrEqual(200);
        }
      }
    }
  });

  it('raw non-JSON bodies and content types', async () => {
    for (const raw of ['{', '[1,2', 'null', '\u0000', '{"a":1}}', '<xml/>']) {
      for (const type of ['application/json', 'text/plain', 'application/x-www-form-urlencoded']) {
        const res = await w.as.lead.post('/tickets/bulk').set('Content-Type', type).send(raw);
        expect(res.status, `${type} ${raw}`).toBeLessThan(500);
      }
    }
    const res = await w.as.lead.post('/attachments').set('Content-Type', 'multipart/form-data');
    expect(res.status).toBeLessThan(500);
    const broken = await w.as.lead
      .post('/attachments')
      .set('Content-Type', 'multipart/form-data; boundary=x')
      .send('--x\r\nContent-Disposition: form-data; name="file"; filename="a"\r\n\r\nabc');
    expect(broken.status).toBeLessThan(500);
  });

  it('path parameters', async () => {
    for (const agent of [w.as.customer, w.as.lead]) {
      for (const id of BAD_IDS) {
        for (const [method, path] of [
          ['get', `/tickets/${id}`],
          ['patch', `/tickets/${id}`],
          ['post', `/tickets/${id}/messages`],
          ['post', `/tickets/${id}/resolve`],
          ['post', `/tickets/${id}/read`],
          ['post', `/tickets/${id}/typing`],
          ['get', `/attachments/${id}`],
          ['delete', `/views/${id}`],
          ['delete', `/canned-responses/${id}`],
        ] as const) {
          const res = await agent[method](path).send({});
          expect(res.status, `${method} ${path}`).toBeLessThan(500);
        }
      }
    }
  });

  it('query strings', async () => {
    for (const agent of [w.as.customer, w.as.billingAgent, w.as.lead]) {
      for (const q of BAD_QUERIES) {
        for (const base of ['/tickets', '/notifications', '/stats']) {
          const res = await agent.get(`${base}${q}`);
          expect(res.status, `${base}${q}`).toBeLessThan(500);
        }
      }
    }
  });

  it('unknown methods and routes', async () => {
    for (const res of [
      await w.as.lead.put('/tickets'),
      await w.as.lead.delete('/tickets/bulk'),
      await w.as.lead.get('/%00'),
      await w.as.lead.get('/tickets/%E0%A4%A'),
    ]) {
      expect(res.status).toBeLessThan(500);
      expect(res.body.error).toBeDefined();
    }
  });
});
