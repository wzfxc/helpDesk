import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS } from '@helpdesk/shared';
import { RateLimiter } from '../src/common/rate-limiter.js';
import { createTestApp, createUser, PASSWORD, type TestContext } from './app.js';
import { resetDb } from './db.js';
import { createTicket, createWorld } from './fixtures.js';

/**
 * Behind the Next.js proxy every browser reaches the api from the web container; the real client
 * address arrives in X-Forwarded-For. The login limiter must count per (email, ip), never lock
 * out unrelated users, and the throttles must answer 429 + Retry-After.
 */
const open: TestContext[] = [];
afterAll(async () => {
  await Promise.all(open.map((c) => c.close()));
});

async function app(overrides: Parameters<typeof createTestApp>[0] = {}) {
  const ctx = await createTestApp(overrides);
  open.push(ctx);
  return ctx;
}

const login = (ctx: TestContext, email: string, password: string, ip: string) =>
  ctx.http.post('/auth/login').set('X-Forwarded-For', ip).send({ email, password });

describe('login limiter', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await app(); // LOGIN_MAX_FAILURES = 5 (default)
  });
  beforeEach(async () => {
    await resetDb(ctx.pool);
  });

  it('10 failed logins for customer1 do not block the lead behind the same proxy address', async () => {
    const customer1 = await createUser(ctx.db, 'customer');
    const lead = await createUser(ctx.db, 'lead');
    const proxyAddress = '172.18.0.5'; // e.g. the web container
    for (let i = 0; i < 10; i++) {
      const r = await login(ctx, customer1.email, 'wrong', proxyAddress);
      expect(r.status).toBe(i < 5 ? 401 : 429);
    }
    const blocked = await login(ctx, customer1.email, PASSWORD, proxyAddress);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

    const ok = await login(ctx, lead.email, PASSWORD, proxyAddress);
    expect(ok.status).toBe(200);
  });

  it('uses the real client address from X-Forwarded-For: same account, other address is not blocked', async () => {
    const user = await createUser(ctx.db, 'customer');
    for (let i = 0; i < 5; i++) await login(ctx, user.email, 'wrong', '203.0.113.10');
    expect((await login(ctx, user.email, PASSWORD, '203.0.113.10')).status).toBe(429);
    expect((await login(ctx, user.email, PASSWORD, '203.0.113.11')).status).toBe(200);
  });

  it("a successful login does not reset another address's counter", async () => {
    const user = await createUser(ctx.db, 'customer');
    for (let i = 0; i < 4; i++) await login(ctx, user.email, 'wrong', '203.0.113.20');
    expect((await login(ctx, user.email, PASSWORD, '203.0.113.21')).status).toBe(200);
    // the attacker's address still has its 4 failures: one more is allowed, then blocked
    expect((await login(ctx, user.email, 'wrong', '203.0.113.20')).status).toBe(401);
    expect((await login(ctx, user.email, 'wrong', '203.0.113.20')).status).toBe(429);
    // success from the legitimate address forgives only its own failures
    expect((await login(ctx, user.email, PASSWORD, '203.0.113.21')).status).toBe(200);
  });

  it('guessing one account from many addresses still hits the per-account backstop', async () => {
    const user = await createUser(ctx.db, 'customer');
    const max = 5 * 10;
    for (let i = 0; i < max; i++) {
      await login(ctx, user.email, 'wrong', `198.51.100.${(i + 1).toString()}`);
    }
    const r = await login(ctx, user.email, PASSWORD, '198.51.100.250');
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBeDefined();
  });

  it('spoofed X-Forwarded-For from an untrusted peer is ignored', async () => {
    const strict = await app({ TRUST_PROXY: '10.255.255.254' }); // supertest peer is loopback
    await resetDb(strict.pool);
    const user = await createUser(strict.db, 'customer');
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      statuses.push(
        (await login(strict, user.email, 'wrong', `192.0.2.${(i + 1).toString()}`)).status,
      );
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);
  });
});

describe('throttles', () => {
  it('sliding window: allows `max`, then 429 with Retry-After, then recovers', () => {
    const limiter = new RateLimiter({ RATE_LIMITS_ENABLED: true } as never);
    const rule = { max: 2, windowMs: 1000 };
    limiter.check('b', 'k', rule, 0);
    limiter.check('b', 'k', rule, 100);
    expect(() => {
      limiter.check('b', 'k', rule, 200);
    }).toThrowError(/slow down/);
    limiter.check('b', 'other', rule, 200); // other keys are independent
    limiter.check('b', 'k', rule, 1001); // oldest hit left the window
  });

  it('typing: one signal per second per user and ticket, 429 + Retry-After', async () => {
    const t = await app({ RATE_LIMITS_ENABLED: true });
    await resetDb(t.pool);
    const w = await createWorld(t);
    const ticket = await createTicket(w.as.customer);
    const first = await w.as.billingAgent.post(`/tickets/${ticket.id}/typing`);
    expect(first.status).toBe(204);
    const second = await w.as.billingAgent.post(`/tickets/${ticket.id}/typing`);
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe('rate_limited');
    expect(Number(second.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('ticket creation is throttled per user, not globally', async () => {
    const t = await app({ RATE_LIMITS_ENABLED: true });
    await resetDb(t.pool);
    const w = await createWorld(t);
    const { max } = LIMITS.rate.ticketCreate;
    for (let i = 0; i < max; i++)
      await createTicket(w.as.customer, { subject: `t${i.toString()}` });
    const over = await w.as.customer.post('/tickets').send({
      subject: 's',
      category: 'billing',
      priority: 'low',
      body: 'b',
    });
    expect(over.status).toBe(429);
    expect(over.headers['retry-after']).toBeDefined();
    // another customer is unaffected
    expect((await createTicket(w.as.customer2)).id).toBeDefined();
  });
});
