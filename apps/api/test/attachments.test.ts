import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type TestAgent from 'supertest/lib/agent.js';
import { detectMimeType, isPlainText, sanitizeFilename } from '../src/attachments/detect-type.js';
import { createTestApp, type TestContext } from './app.js';
import { resetDb } from './db.js';
import { createTicket, createWorld, type World } from './fixtures.js';

let ctx: TestContext;
let w: World;

export const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5d2b8e40000000049454e44ae426082',
  'hex',
);
const EXE = Buffer.concat([
  Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'binary'),
  Buffer.alloc(200, 0),
]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

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

export async function upload(agent: TestAgent, buf: Buffer, name: string) {
  return agent.post('/attachments').attach('file', buf, { filename: name });
}

describe('type detection (unit)', () => {
  it('detects by content, not extension', () => {
    expect(detectMimeType(PNG)).toBe('image/png');
    expect(detectMimeType(PDF)).toBe('application/pdf');
    expect(detectMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]))).toBe('image/jpeg');
    expect(detectMimeType(Buffer.from('GIF89a....'))).toBe('image/gif');
    expect(detectMimeType(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'binary'))).toBe(
      'image/webp',
    );
    expect(detectMimeType(Buffer.from('Привіт, світ!\nline 2\t✓'))).toBe('text/plain');
    expect(detectMimeType(EXE)).toBeNull();
    expect(detectMimeType(Buffer.from([0xc3, 0x28]))).toBeNull(); // invalid UTF-8
    expect(isPlainText(Buffer.from('a\x00b', 'binary'))).toBe(false);
  });

  it('sanitizes file names', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\x\\evil<script>.png')).toBe('evil_script_.png');
    expect(sanitizeFilename('')).toBe('file');
  });
});

describe('upload', () => {
  it('stores a valid image under a uuid name', async () => {
    const res = await upload(w.as.customer, PNG, 'screenshot.png');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      filename: 'screenshot.png',
      mimeType: 'image/png',
      size: PNG.length,
    });
    const row = await ctx.pool.query<{ storage_key: string }>(
      'select storage_key from attachments where id = $1',
      [res.body.id],
    );
    const key = row.rows[0]!.storage_key;
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(existsSync(path.resolve('./data/test-attachments', key))).toBe(true);
  });

  it('rejects an .exe renamed to .png with 415', async () => {
    const res = await upload(w.as.customer, EXE, 'cute-cat.png');
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('unsupported_media_type');
  });

  it('rejects an 11 MB file with 413', async () => {
    const big = Buffer.alloc(11 * 1024 * 1024, 0x61); // valid text, but too large
    const res = await upload(w.as.customer, big, 'big.txt');
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('payload_too_large');
  });

  it('accepts text and PDF, rejects empty and missing files', async () => {
    expect((await upload(w.as.customer, Buffer.from('log line\n'), 'log.txt')).body.mimeType).toBe(
      'text/plain',
    );
    expect((await upload(w.as.customer, PDF, 'doc.bin')).body.mimeType).toBe('application/pdf');
    expect((await upload(w.as.customer, Buffer.alloc(0), 'empty.txt')).status).toBe(400);
    expect((await w.as.customer.post('/attachments').send({ file: 'x' })).status).toBe(400);
  });

  it('requires a session', async () => {
    const res = await ctx.http.post('/attachments').attach('file', PNG, { filename: 'a.png' });
    expect(res.status).toBe(401);
  });
});

describe('binding and access', () => {
  it('serves bound attachments to those who can see the ticket, with safe headers', async () => {
    const a = await upload(w.as.customer, PNG, 'фото «1».png');
    const t = await createTicket(w.as.customer, { attachmentIds: [a.body.id] });
    const detail = await w.as.customer.get(`/tickets/${t.id}`);
    expect(detail.body.messages[0].attachments).toEqual([a.body]);

    const own = await w.as.customer.get(`/attachments/${a.body.id}`);
    expect(own.status).toBe(200);
    expect(own.headers['content-type']).toBe('image/png');
    expect(own.headers['x-content-type-options']).toBe('nosniff');
    expect(own.headers['content-disposition']).toContain("filename*=UTF-8''");
    expect(Buffer.from(own.body as Buffer).equals(PNG)).toBe(true);

    expect((await w.as.billingAgent.get(`/attachments/${a.body.id}`)).status).toBe(200);
    expect((await w.as.customer2.get(`/attachments/${a.body.id}`)).status).toBe(404);
    expect((await w.as.techAgent.get(`/attachments/${a.body.id}`)).status).toBe(404);
  });

  it('attachments of internal notes are invisible to the customer', async () => {
    const t = await createTicket(w.as.customer);
    const a = await upload(w.as.billingAgent, PDF, 'internal.pdf');
    const note = await w.as.billingAgent.post(`/tickets/${t.id}/messages`).send({
      clientMessageId: randomUUID(),
      body: 'see attached',
      internal: true,
      attachmentIds: [a.body.id],
    });
    expect(note.status).toBe(201);
    expect((await w.as.customer.get(`/attachments/${a.body.id}`)).status).toBe(404);
    expect((await w.as.lead.get(`/attachments/${a.body.id}`)).status).toBe(200);
  });

  it('unbound attachments are visible to the uploader only', async () => {
    const a = await upload(w.as.billingAgent, PNG, 'x.png');
    expect((await w.as.billingAgent.get(`/attachments/${a.body.id}`)).status).toBe(200);
    expect((await w.as.lead.get(`/attachments/${a.body.id}`)).status).toBe(404);
  });

  it("cannot bind someone else's or an already used attachment", async () => {
    const foreign = await upload(w.as.customer2, PNG, 'x.png');
    const res = await w.as.customer.post('/tickets').send({
      subject: 's',
      category: 'billing',
      priority: 'low',
      body: 'b',
      attachmentIds: [foreign.body.id],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('attachment_unavailable');

    const mine = await upload(w.as.customer, PNG, 'x.png');
    await createTicket(w.as.customer, { attachmentIds: [mine.body.id] });
    const again = await w.as.customer.post('/tickets').send({
      subject: 's',
      category: 'billing',
      priority: 'low',
      body: 'b',
      attachmentIds: [mine.body.id],
    });
    expect(again.status).toBe(422);
  });

  it('allows at most 5 attachments per message', async () => {
    const t = await createTicket(w.as.customer);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await upload(w.as.customer, PNG, `${i}.png`)).body.id);
    const six = await w.as.customer
      .post(`/tickets/${t.id}/messages`)
      .send({ clientMessageId: randomUUID(), body: 'x', attachmentIds: ids });
    expect(six.status).toBe(400);
    const five = await w.as.customer
      .post(`/tickets/${t.id}/messages`)
      .send({ clientMessageId: randomUUID(), body: 'x', attachmentIds: ids.slice(0, 5) });
    expect(five.status).toBe(201);
    expect(five.body.message.attachments).toHaveLength(5);
  });

  it('rejects malformed ids', async () => {
    expect((await w.as.customer.get('/attachments/../../etc/passwd')).status).toBe(404);
    expect((await w.as.customer.get('/attachments/nope')).status).toBe(400);
  });
});
