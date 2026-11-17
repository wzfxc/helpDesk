import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS } from '@helpdesk/shared';
import { createTestApp, type TestContext } from './app.js';
import { resetDb } from './db.js';
import { createTicket, createWorld, PNG, upload, type World } from './fixtures.js';

/**
 * One integration test per user-visible limit. Every violation must be a 4xx in the unified
 * error format ({ error: { code, message } }), never a 5xx and never silent truncation.
 */
let ctx: TestContext;
let w: World;
const DIR = path.resolve('./data/test-attachments');
const files = () => readdirSync(DIR).length;

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

const text = (bytes: number) => Buffer.alloc(bytes, 0x61);

describe('attachment size', () => {
  it('10 MiB exactly is accepted, 10 MiB + 1 byte is 413 and leaves no file behind', async () => {
    expect(LIMITS.attachmentMaxBytes).toBe(10 * 1024 * 1024);
    const ok = await upload(w.as.customer, text(LIMITS.attachmentMaxBytes), 'max.txt');
    expect(ok.status).toBe(201);
    expect(ok.body.size).toBe(LIMITS.attachmentMaxBytes);

    const before = files();
    const big = await upload(w.as.customer, text(LIMITS.attachmentMaxBytes + 1), 'big.txt');
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('payload_too_large');
    expect(big.body.error.message).toContain(`${LIMITS.attachmentMaxMb.toString()} MB`);
    expect(files()).toBe(before);
  });

  it('a 25 MB upload is rejected with 413 as well', async () => {
    const res = await upload(w.as.customer, text(25 * 1024 * 1024), 'huge.txt');
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('payload_too_large');
  });
});

describe('multipart guards', () => {
  it('too many fields / parts / oversized field are 400, not 5xx', async () => {
    let req = w.as.customer.post('/attachments');
    for (let i = 0; i <= LIMITS.multipartMaxFields; i++) req = req.field(`f${i.toString()}`, 'x');
    const manyFields = await req.attach('file', PNG, { filename: 'a.png' });
    expect(manyFields.status).toBe(400);
    expect(manyFields.body.error).toBeDefined();

    let parts = w.as.customer.post('/attachments');
    for (let i = 0; i <= LIMITS.multipartMaxParts; i++) {
      parts = parts.attach('file', PNG, { filename: `a${i.toString()}.png` });
    }
    expect((await parts).status).toBe(400);

    const fat = await w.as.customer
      .post('/attachments')
      .field('x', 'y'.repeat(LIMITS.multipartFieldBytes + 1))
      .attach('file', PNG, { filename: 'a.png' });
    expect(fat.status).toBe(400);

    const longName = await w.as.customer
      .post('/attachments')
      .field('n'.repeat(LIMITS.multipartFieldNameBytes + 1), 'y')
      .attach('file', PNG, { filename: 'a.png' });
    expect(longName.status).toBe(400);
  });

  it('a second file or a wrong field name is a 400', async () => {
    const wrong = await w.as.customer.post('/attachments').attach('other', PNG, 'a.png');
    expect(wrong.status).toBe(400);
  });
});

describe('attachment count and binding', () => {
  it('the 6th attachment on one message is a 400 validation_error', async () => {
    const ids: string[] = [];
    for (let i = 0; i < LIMITS.attachmentsPerMessage + 1; i++) {
      ids.push((await upload(w.as.customer, PNG, `a${i.toString()}.png`)).body.id as string);
    }
    const six = await w.as.customer
      .post('/tickets')
      .send({ subject: 's', category: 'billing', priority: 'low', body: 'b', attachmentIds: ids });
    expect(six.status).toBe(400);
    expect(six.body.error.code).toBe('validation_error');
    const five = await createTicket(w.as.customer, { attachmentIds: ids.slice(0, 5) });
    const msg = await w.as.customer
      .post(`/tickets/${five.id}/messages`)
      .send({ clientMessageId: randomUUID(), body: 'again', attachmentIds: ids });
    expect(msg.status).toBe(400);
  });

  it("binding someone else's or an already bound attachment is 422", async () => {
    const mine = (await upload(w.as.customer, PNG, 'a.png')).body.id as string;
    const foreign = (await upload(w.as.customer2, PNG, 'b.png')).body.id as string;
    const t = await createTicket(w.as.customer, { attachmentIds: [mine] });
    const stolen = await w.as.customer.post('/tickets').send({
      subject: 's',
      category: 'billing',
      priority: 'low',
      body: 'b',
      attachmentIds: [foreign],
    });
    expect(stolen.status).toBe(422);
    expect(stolen.body.error.code).toBe('attachment_unavailable');
    const reused = await w.as.customer
      .post(`/tickets/${t.id}/messages`)
      .send({ clientMessageId: randomUUID(), body: 'x', attachmentIds: [mine] });
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe('attachment_unavailable');
  });

  it('caps unattached uploads per user (count), other users are unaffected', async () => {
    for (let i = 0; i < LIMITS.unboundAttachmentsMax; i++) {
      expect((await upload(w.as.customer, PNG, `a${i.toString()}.png`)).status).toBe(201);
    }
    const over = await upload(w.as.customer, PNG, 'over.png');
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('attachment_quota_exceeded');
    expect((await upload(w.as.customer2, PNG, 'ok.png')).status).toBe(201);
  });

  it('parallel uploads cannot overshoot the quota', async () => {
    const results = await Promise.all(
      Array.from({ length: LIMITS.unboundAttachmentsMax + 8 }, (_, i) =>
        upload(w.as.customer, PNG, `p${i.toString()}.png`),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(LIMITS.unboundAttachmentsMax);
    expect(results.filter((r) => r.status === 422)).toHaveLength(8);
    const left = await ctx.pool.query<{ n: string }>(
      'select count(*)::text as n from attachments where uploader_id = $1',
      [w.customer.id],
    );
    expect(Number(left.rows[0]?.n)).toBe(LIMITS.unboundAttachmentsMax);
  });

  it('caps unattached uploads per user (bytes)', async () => {
    const chunk = text(LIMITS.attachmentMaxBytes);
    const n = Math.floor(LIMITS.unboundAttachmentsMaxBytes / chunk.length);
    for (let i = 0; i < n; i++) {
      expect((await upload(w.as.customer, chunk, `c${i.toString()}.txt`)).status).toBe(201);
    }
    const over = await upload(w.as.customer, chunk, 'over.txt');
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('attachment_quota_exceeded');
  });
});

describe('JSON body limit (every endpoint except POST /attachments)', () => {
  const big = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ body: 'x'.repeat(LIMITS.jsonBodyMaxBytes + 1), ...extra });

  it('rejects bodies above the limit with 413 payload_too_large', async () => {
    const t = await createTicket(w.as.customer);
    const targets: [string, string, 'customer' | 'billingAgent' | 'lead'][] = [
      ['post', '/tickets', 'customer'],
      ['post', `/tickets/${t.id}/messages`, 'customer'],
      ['patch', `/tickets/${t.id}`, 'billingAgent'],
      ['post', `/tickets/${t.id}/rating`, 'customer'],
      ['post', '/tickets/bulk', 'lead'],
      ['post', '/canned-responses', 'lead'],
      ['post', '/views', 'lead'],
      ['put', '/sla-policies', 'lead'],
      ['post', '/notifications/read', 'customer'],
    ];
    for (const [method, url, who] of targets) {
      const res = await w.as[who][method as 'post' | 'patch' | 'put'](url)
        .set('Content-Type', 'application/json')
        .send(big());
      expect(res.status, `${method} ${url}`).toBe(413);
      expect(res.body.error.code).toBe('payload_too_large');
    }
    const login = await ctx.http
      .post('/auth/login')
      .set('Content-Type', 'application/json')
      .send(big());
    expect(login.status).toBe(413);
    const form = await ctx.http
      .post('/auth/login')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`a=${'x'.repeat(LIMITS.jsonBodyMaxBytes + 1)}`);
    // form posts are never parsed (CSRF-able content type): the credentials are not read at all
    expect(form.status).toBe(400);
    expect(form.body.error.code).toBe('validation_error');
    const forged = await ctx.http
      .post('/auth/login')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('email=a@b.co&password=x');
    expect(forged.status).toBe(400);
  });

  it('a body just under the limit still reaches validation (400, not 413)', async () => {
    const res = await w.as.customer
      .post('/tickets')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ body: 'x'.repeat(LIMITS.jsonBodyMaxBytes - 100) }));
    expect(res.status).toBe(400);
  });
});

describe('text field lengths (max accepted, max + 1 -> 400 validation_error)', () => {
  const rep = (n: number) => 'x'.repeat(n);
  const cases: { name: string; make: (n: number) => [string, string, object]; max: number }[] = [
    {
      name: 'subject',
      max: LIMITS.subjectMax,
      make: (n) => [
        'post',
        '/tickets',
        { subject: rep(n), category: 'billing', priority: 'low', body: 'b' },
      ],
    },
    {
      name: 'ticket body',
      max: LIMITS.messageBodyMax,
      make: (n) => [
        'post',
        '/tickets',
        { subject: 's', category: 'billing', priority: 'low', body: rep(n) },
      ],
    },
    {
      name: 'canned title',
      max: LIMITS.cannedTitleMax,
      make: (n) => ['post', '/canned-responses', { title: rep(n), body: 'b' }],
    },
    {
      name: 'canned body',
      max: LIMITS.cannedBodyMax,
      make: (n) => ['post', '/canned-responses', { title: 't', body: rep(n) }],
    },
    {
      name: 'saved view name',
      max: LIMITS.viewNameMax,
      make: (n) => ['post', '/views', { name: rep(n), query: 'status=open' }],
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const who =
        c.name.startsWith('canned') || c.name.startsWith('saved') ? w.as.lead : w.as.customer;
      const [method, url, ok] = c.make(c.max);
      expect((await who[method as 'post'](url).send(ok)).status).toBe(201);
      const [, , bad] = c.make(c.max + 1);
      const res = await who[method as 'post'](url).send(bad);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    });
  }

  it('message body, rating comment, tags, login email/password, search, cursor, version', async () => {
    const t = await createTicket(w.as.customer);
    const post = (body: object) =>
      w.as.customer
        .post(`/tickets/${t.id}/messages`)
        .send({ clientMessageId: randomUUID(), ...body });
    expect((await post({ body: 'x'.repeat(LIMITS.messageBodyMax + 1) })).status).toBe(400);
    expect(
      (
        await w.as.customer
          .post(`/tickets/${t.id}/rating`)
          .send({ score: 5, comment: 'x'.repeat(LIMITS.ratingCommentMax + 1) })
      ).status,
    ).toBe(400);

    const patch = (b: object) => w.as.billingAgent.patch(`/tickets/${t.id}`).send(b);
    expect(
      (await patch({ version: t.version, tags: ['x'.repeat(LIMITS.tagMax + 1)] })).status,
    ).toBe(400);
    const manyTags = Array.from({ length: LIMITS.tagsPerTicket + 1 }, (_, i) => `t${i.toString()}`);
    expect((await patch({ version: t.version, tags: manyTags })).status).toBe(400);
    expect((await patch({ version: LIMITS.versionMax + 1, tags: [] })).status).toBe(400);
    expect((await patch({ version: -1, tags: [] })).status).toBe(400);

    for (const body of [
      { email: `${'a'.repeat(LIMITS.emailMax)}@x.co`, password: 'x' },
      { email: 'a@b.co', password: 'x'.repeat(LIMITS.passwordMax + 1) },
    ]) {
      const res = await ctx.http.post('/auth/login').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    }

    const q = await w.as.lead.get('/tickets').query({ q: 'x'.repeat(LIMITS.searchQueryMax + 1) });
    expect(q.status).toBe(400);
    const cursor = await w.as.lead
      .get('/tickets')
      .query({ cursor: 'A'.repeat(LIMITS.cursorMax + 1) });
    expect(cursor.status).toBe(400);
  });
});

describe('pagination limit', () => {
  it('limit outside 1..100 or non-numeric is 400 validation_error', async () => {
    for (const limit of ['0', '-1', 'abc', '101', '1e9', '1.5', '', '9999999999']) {
      const res = await w.as.lead.get('/tickets').query({ limit });
      expect(res.status, `limit=${limit}`).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    }
    expect((await w.as.lead.get('/tickets').query({ limit: '1' })).status).toBe(200);
    expect((await w.as.lead.get('/tickets').query({ limit: '100' })).status).toBe(200);
  });
});

describe('bulk', () => {
  it('200 ids pass; 201, empty and duplicate ids are 400; tags obey PATCH limits', async () => {
    const t = await createTicket(w.as.customer);
    const action = { type: 'priority', priority: 'high' };
    const ids = (n: number) => Array.from({ length: n }, () => randomUUID());

    const ok = await w.as.lead.post('/tickets/bulk').send({ ids: ids(LIMITS.bulkMax), action });
    expect(ok.status).toBe(200);
    expect(ok.body.skipped).toBe(LIMITS.bulkMax); // unknown ids are reported, not failed

    for (const bad of [ids(LIMITS.bulkMax + 1), [], [t.id, t.id]]) {
      const res = await w.as.lead.post('/tickets/bulk').send({ ids: bad, action });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    }

    for (const tags of [
      ['x'.repeat(LIMITS.tagMax + 1)],
      Array.from({ length: 21 }, (_, i) => `t${i.toString()}`),
    ]) {
      const res = await w.as.lead
        .post('/tickets/bulk')
        .send({ ids: [t.id], action: { type: 'tags', add: tags, remove: [] } });
      expect(res.status).toBe(400);
    }
  });
});
