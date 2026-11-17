import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type TestAgent from 'supertest/lib/agent.js';
import { encodeCursor, toTsQuery } from '../src/tickets/ticket-list.js';
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
  ctx.clock.set('2025-01-07T08:00:00.000Z');
  w = await createWorld(ctx);
});
afterAll(async () => {
  await ctx.close();
});

async function list(
  agent: TestAgent,
  query = '',
): Promise<{
  items: { id: string; number: number }[];
  nextCursor: string | null;
  status: number;
  body: Record<string, unknown>;
}> {
  const res = await agent.get(`/tickets${query}`);
  return { ...res.body, status: res.status, body: res.body };
}

async function all(agent: TestAgent, query: string, limit = 2): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 100; i++) {
    const sep = query ? '&' : '?';
    const res = await agent.get(
      `/tickets${query}${sep}limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`,
    );
    expect(res.status).toBe(200);
    ids.push(...(res.body.items as { id: string }[]).map((t) => t.id));
    cursor = res.body.nextCursor as string | null;
    if (!cursor) break;
  }
  return ids;
}

describe('list permissions', () => {
  it('scopes results by role in SQL', async () => {
    const billing = await createTicket(w.as.customer, { category: 'billing' });
    const tech = await createTicket(w.as.customer, { category: 'technical' });
    const other = await createTicket(w.as.customer2, { category: 'billing' });

    expect((await all(w.as.customer, '')).sort()).toEqual([billing.id, tech.id].sort());
    expect(await all(w.as.customer2, '')).toEqual([other.id]);
    expect((await all(w.as.billingAgent, '')).sort()).toEqual([billing.id, other.id].sort());
    expect(await all(w.as.techAgent, '')).toEqual([tech.id]);
    expect((await all(w.as.lead, '')).length).toBe(3);

    // assigned tickets of other categories become visible to the agent
    await w.as.lead
      .patch(`/tickets/${billing.id}`)
      .send({ version: 0, assigneeId: w.techAgent.id });
    expect((await all(w.as.techAgent, '')).sort()).toEqual([billing.id, tech.id].sort());
  });
});

describe('filters', () => {
  it('status, priority, category, assignee, tags, period, sla', async () => {
    const a = await createTicket(w.as.customer, { priority: 'high', category: 'billing' });
    ctx.clock.advance(60_000);
    const b = await createTicket(w.as.customer, { priority: 'low', category: 'technical' });
    ctx.clock.advance(60_000);
    const c = await createTicket(w.as.customer, { priority: 'normal', category: 'billing' });
    await w.as.lead
      .patch(`/tickets/${a.id}`)
      .send({ version: 0, status: 'open', assigneeId: w.billingAgent.id, tags: ['vip', 'refund'] });
    await w.as.lead.patch(`/tickets/${b.id}`).send({ version: 0, tags: ['vip'] });

    const ids = async (q: string) => (await all(w.as.lead, q, 50)).sort();
    expect(await ids('?status=open')).toEqual([a.id]);
    expect(await ids('?status=new,open')).toEqual([a.id, b.id, c.id].sort());
    expect(await ids('?priority=high&priority=low')).toEqual([a.id, b.id].sort());
    expect(await ids('?category=billing')).toEqual([a.id, c.id].sort());
    expect(await ids('?assignee=none')).toEqual([b.id, c.id].sort());
    expect(await ids(`?assignee=${w.billingAgent.id}`)).toEqual([a.id]);
    expect(await all(w.as.billingAgent, '?assignee=me', 50)).toEqual([a.id]);
    expect(await ids('?tags=vip')).toEqual([a.id, b.id].sort());
    expect(await ids('?tags=vip,refund')).toEqual([a.id]);
    expect(await ids(`?createdFrom=${encodeURIComponent('2025-01-07T08:00:30Z')}`)).toEqual(
      [b.id, c.id].sort(),
    );
    expect(await ids(`?createdTo=${encodeURIComponent('2025-01-07T08:00:30Z')}`)).toEqual([a.id]);
    expect(await ids('?slaBreached=true')).toEqual([]);
    ctx.clock.advance(5 * 3_600_000); // high first-response (4h) is now overdue
    expect(await ids('?slaRisk=true')).toContain(a.id);
    await ctx.pool.query('update tickets set sla_breached_first = true where id = $1', [a.id]);
    expect(await ids('?slaBreached=true')).toEqual([a.id]);
    expect(await ids('?slaBreached=false')).toEqual([b.id, c.id].sort());
  });

  it('rejects invalid filters with 400', async () => {
    for (const q of [
      '?status=bogus',
      '?limit=0',
      '?limit=101',
      '?assignee=x',
      '?createdFrom=yesterday',
      '?slaBreached=maybe',
      '?sort=random',
      `?q=${'x'.repeat(201)}`,
    ]) {
      const res = await w.as.lead.get(`/tickets${q}`);
      expect(res.status, q).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    }
  });
});

describe('sorting and cursor pagination', () => {
  it('walks every page exactly once for each sort, including ties', async () => {
    const created: string[] = [];
    for (let i = 0; i < 7; i++) {
      // pairs share the same timestamp to exercise the (key, id) tie-breaker
      if (i % 2 === 0) ctx.clock.advance(60_000);
      created.push((await createTicket(w.as.customer, { priority: 'normal' })).id);
    }
    for (const sort of ['created', '-created', 'updated', '-updated', 'sla', '-sla']) {
      const ids = await all(w.as.lead, `?sort=${sort}`, 2);
      expect(ids, sort).toHaveLength(7);
      expect(new Set(ids).size, sort).toBe(7);
    }
    const asc = await all(w.as.lead, '?sort=created', 3);
    const desc = await all(w.as.lead, '?sort=-created', 3);
    expect(desc).toEqual([...asc].reverse());
  });

  it('sla sort puts the nearest deadline first and paused tickets last', async () => {
    const low = await createTicket(w.as.customer, { priority: 'low' });
    const high = await createTicket(w.as.customer, { priority: 'high' });
    const paused = await createTicket(w.as.customer, { priority: 'high' });
    await w.as.lead.patch(`/tickets/${paused.id}`).send({ version: 0, status: 'pending' });
    expect(await all(w.as.lead, '?sort=sla', 10)).toEqual([high.id, low.id, paused.id]);
  });

  it('rejects broken or foreign cursors with 400 invalid_cursor', async () => {
    await createTicket(w.as.customer);
    for (const cursor of [
      'garbage',
      Buffer.from('{"s":"sla"}').toString('base64url'),
      encodeCursor({ s: 'created', v: '2025-01-01 00:00:00+00', id: randomUUID() }),
      Buffer.from('{"s":"sla","v":"1; drop table tickets","id":"x"}').toString('base64url'),
    ]) {
      const res = await w.as.lead.get(`/tickets?sort=sla&cursor=${cursor}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_cursor');
    }
  });
});

describe('full-text search', () => {
  it('finds tickets by subject words (prefix) and by message text', async () => {
    const a = await createTicket(w.as.customer, { subject: 'Refund for double payment' });
    const b = await createTicket(w.as.customer, { subject: 'Доставка затримується' });
    await w.as.customer
      .post(`/tickets/${b.id}/messages`)
      .send({ clientMessageId: randomUUID(), body: 'Номер накладної 59000123' });

    expect(await all(w.as.lead, '?q=refund', 10)).toEqual([a.id]);
    expect(await all(w.as.lead, '?q=paym', 10)).toEqual([a.id]);
    expect(await all(w.as.lead, `?q=${encodeURIComponent('доставка')}`, 10)).toEqual([b.id]);
    expect(await all(w.as.lead, `?q=${encodeURIComponent('накладної')}`, 10)).toEqual([b.id]);
    expect(await all(w.as.lead, '?q=59000123', 10)).toEqual([b.id]);
    expect(await all(w.as.lead, `?q=HD-${a.number}`, 10)).toEqual([a.id]);
    expect(await all(w.as.lead, '?q=nothingmatches', 10)).toEqual([]);
    expect(await all(w.as.lead, `?q=${encodeURIComponent("'&|!:*")}`, 10)).toEqual([]);
  });

  it('a customer never finds a ticket by the text of an internal note', async () => {
    const t = await createTicket(w.as.customer, { subject: 'Login issue' });
    await w.as.billingAgent.post(`/tickets/${t.id}/messages`).send({
      clientMessageId: randomUUID(),
      body: 'suspectedfraud internal remark',
      internal: true,
    });
    expect(await all(w.as.billingAgent, '?q=suspectedfraud', 10)).toEqual([t.id]);
    expect(await all(w.as.customer, '?q=suspectedfraud', 10)).toEqual([]);
  });

  it('builds safe prefix queries', () => {
    expect(toTsQuery('Hello, wor')).toBe('hello:* & wor:*');
    expect(toTsQuery("'&|!")).toBeNull();
  });
});

describe('unread', () => {
  it('highlights new staff replies for the customer until read', async () => {
    const t = await createTicket(w.as.customer);
    let res = await list(w.as.customer);
    expect((res.items[0] as unknown as { unread: boolean }).unread).toBe(false);
    ctx.clock.advance(60_000);
    await w.as.billingAgent
      .post(`/tickets/${t.id}/messages`)
      .send({ clientMessageId: randomUUID(), body: 'Hi' });
    res = await list(w.as.customer);
    expect((res.items[0] as unknown as { unread: boolean }).unread).toBe(true);
    ctx.clock.advance(60_000);
    await w.as.customer.post(`/tickets/${t.id}/read`).expect(204);
    res = await list(w.as.customer);
    expect((res.items[0] as unknown as { unread: boolean }).unread).toBe(false);
  });

  it('internal notes do not make a ticket unread for the customer', async () => {
    const t = await createTicket(w.as.customer);
    ctx.clock.advance(60_000);
    await w.as.billingAgent
      .post(`/tickets/${t.id}/messages`)
      .send({ clientMessageId: randomUUID(), body: 'note', internal: true });
    const res = await list(w.as.customer);
    expect((res.items[0] as unknown as { unread: boolean }).unread).toBe(false);
  });
});
