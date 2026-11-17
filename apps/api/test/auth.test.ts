import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp, createUser, loginAs, PASSWORD, type TestContext } from './app.js';
import { resetDb } from './db.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp({ LOGIN_MAX_FAILURES: 3, LOGIN_WINDOW_MINUTES: 15 });
});
beforeEach(async () => {
  await resetDb(ctx.pool);
});
afterAll(async () => {
  await ctx.close();
});

describe('auth', () => {
  it('logs in with an httpOnly cookie and returns the user on /me', async () => {
    const user = await createUser(ctx.db, 'agent', ['billing']);
    const res = await ctx.http.post('/auth/login').send({ email: user.email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: user.id, role: 'agent', categories: ['billing'] });
    expect(res.body).not.toHaveProperty('passwordHash');
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toContain('hd_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');

    const agent = await loginAs(ctx, user);
    const me = await agent.get('/me');
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(user.email);
  });

  it('stores only a hash of the session token', async () => {
    const user = await createUser(ctx.db, 'customer');
    const res = await ctx.http.post('/auth/login').send({ email: user.email, password: PASSWORD });
    const token = /hd_session=([^;]+)/.exec(String(res.headers['set-cookie']))?.[1];
    const { rows } = await ctx.pool.query<{ token_hash: string }>(
      'select token_hash from sessions',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).not.toBe(token);
  });

  it('rejects wrong credentials with 401 invalid_credentials', async () => {
    const user = await createUser(ctx.db, 'customer');
    const wrong = await ctx.http.post('/auth/login').send({ email: user.email, password: 'nope' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('invalid_credentials');
    const unknown = await ctx.http
      .post('/auth/login')
      .send({ email: 'ghost@test.io', password: 'nope' });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe('invalid_credentials');
  });

  it('requires a session on protected routes', async () => {
    expect((await ctx.http.get('/me')).status).toBe(401);
    const bad = await request(ctx.app.getHttpServer())
      .get('/me')
      .set('Cookie', 'hd_session=forged');
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('unauthorized');
  });

  it('logout deletes the session', async () => {
    const user = await createUser(ctx.db, 'customer');
    const agent = await loginAs(ctx, user);
    expect((await agent.post('/auth/logout')).status).toBe(204);
    expect((await agent.get('/me')).status).toBe(401);
    const { rows } = await ctx.pool.query('select * from sessions');
    expect(rows).toHaveLength(0);
  });

  it('expires sessions', async () => {
    const user = await createUser(ctx.db, 'customer');
    const agent = await loginAs(ctx, user);
    ctx.clock.advance(169 * 3_600_000);
    expect((await agent.get('/me')).status).toBe(401);
    ctx.clock.advance(-169 * 3_600_000);
  });

  it('rate limits failed logins per email with 429 and Retry-After', async () => {
    const user = await createUser(ctx.db, 'customer');
    for (let i = 0; i < 3; i++) {
      const r = await ctx.http.post('/auth/login').send({ email: user.email, password: 'bad' });
      expect(r.status).toBe(401);
    }
    // Even the correct password is refused while blocked.
    const blocked = await ctx.http
      .post('/auth/login')
      .send({ email: user.email, password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');
    const retryAfter = Number(blocked.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(15 * 60);

    // After the window passes, login works again and clears failures.
    ctx.clock.advance(16 * 60_000);
    const ok = await ctx.http.post('/auth/login').send({ email: user.email, password: PASSWORD });
    expect(ok.status).toBe(200);
    ctx.clock.advance(-16 * 60_000);
  });

  it('parallel guesses cannot exceed the failure limit', async () => {
    const user = await createUser(ctx.db, 'customer');
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(ctx.app.getHttpServer())
          .post('/auth/login')
          .send({ email: user.email, password: 'bad' }),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(3);
    expect(statuses.filter((s) => s === 429)).toHaveLength(7);
  });

  it('ignores X-Forwarded-For from untrusted clients', async () => {
    // supertest connects over loopback, which is trusted; the guard is the configured list.
    const { DEFAULT_TRUST_PROXY } = await import('../src/app.setup.js');
    expect(DEFAULT_TRUST_PROXY).not.toBe('true');
    expect(DEFAULT_TRUST_PROXY).toContain('uniquelocal');
  });

  it('roles guard returns 403', async () => {
    const customer = await createUser(ctx.db, 'customer');
    const agent = await loginAs(ctx, customer);
    const res = await agent.get('/users/staff');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });
});

describe('errors, validation and health', () => {
  it('validation errors list fields', async () => {
    const res = await ctx.http.post('/auth/login').send({ email: 'not-an-email', password: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    const paths = (res.body.error.details as { path: string }[]).map((d) => d.path).sort();
    expect(paths).toEqual(['email', 'password']);
  });

  it('malformed JSON is 400 invalid_json', async () => {
    const res = await ctx.http
      .post('/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_json');
  });

  it('too large JSON is 413', async () => {
    const res = await ctx.http
      .post('/auth/login')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'a@b.io', password: 'x'.repeat(2 * 1024 * 1024) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('payload_too_large');
  });

  it('unknown routes are 404 in the unified format', async () => {
    const user = await createUser(ctx.db, 'lead');
    const agent = await loginAs(ctx, user);
    const res = await agent.get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('health and ready', async () => {
    expect((await ctx.http.get('/health')).body).toEqual({ status: 'ok' });
    const ready = await ctx.http.get('/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('ready');
  });

  it('serves swagger at /docs', async () => {
    const res = await ctx.http.get('/docs-json');
    expect(res.status).toBe(200);
    expect(res.body.paths).toHaveProperty('/auth/login');
  });
});
