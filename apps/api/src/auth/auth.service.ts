import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { and, eq, gt, or, sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { Clock } from '../common/clock.js';
import { ApiError } from '../common/errors.js';
import { DB, type Db, type DbOrTx } from '../db/db.js';
import { loginAttempts, sessions, users } from '../db/schema.js';
import type { AuthUser } from './auth.types.js';

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

@Injectable()
export class AuthService {
  /** Verified against for unknown emails so response time does not reveal which accounts exist. */
  private dummyHash: Promise<string> | undefined;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  /**
   * Throws 429 when the (email, ip) pair has too many recent failures. Counting per pair keeps
   * one user's typos (or an attacker guessing one account) from locking other users out, even
   * when everybody shares an address (all browsers reach the api through the web proxy).
   * Two coarse backstops remain: per account from any address and per address across accounts.
   */
  async assertNotLimited(db: DbOrTx, email: string, ip: string): Promise<void> {
    const now = this.clock.now();
    const windowStart = new Date(now.getTime() - this.config.LOGIN_WINDOW_MINUTES * 60_000);
    const [r] = await db
      .select({
        byPair: sql<number>`count(*) filter (where ${loginAttempts.email} = ${email} and ${loginAttempts.ip} = ${ip})::int`,
        byEmail: sql<number>`count(*) filter (where ${loginAttempts.email} = ${email})::int`,
        byIp: sql<number>`count(*) filter (where ${loginAttempts.ip} = ${ip})::int`,
        oldestPair: sql<Date | null>`min(${loginAttempts.attemptedAt}) filter (where ${loginAttempts.email} = ${email} and ${loginAttempts.ip} = ${ip})`,
        oldestEmail: sql<Date | null>`min(${loginAttempts.attemptedAt}) filter (where ${loginAttempts.email} = ${email})`,
        oldestIp: sql<Date | null>`min(${loginAttempts.attemptedAt}) filter (where ${loginAttempts.ip} = ${ip})`,
      })
      .from(loginAttempts)
      .where(
        and(
          gt(loginAttempts.attemptedAt, windowStart),
          or(eq(loginAttempts.email, email), eq(loginAttempts.ip, ip)),
        ),
      );
    if (!r) return;
    const max = this.config.LOGIN_MAX_FAILURES;
    const emailMax = this.config.LOGIN_EMAIL_MAX_FAILURES ?? max * 10;
    const ipMax = this.config.LOGIN_IP_MAX_FAILURES ?? max * 40;
    let oldest: Date | null;
    if (r.byPair >= max) oldest = r.oldestPair;
    else if (r.byEmail >= emailMax) oldest = r.oldestEmail;
    else if (r.byIp >= ipMax) oldest = r.oldestIp;
    else return;
    const oldestMs = oldest ? new Date(oldest).getTime() : now.getTime();
    const retryAfter = Math.max(
      1,
      Math.ceil((oldestMs + this.config.LOGIN_WINDOW_MINUTES * 60_000 - now.getTime()) / 1000),
    );
    throw new ApiError(
      429,
      'rate_limited',
      'Too many failed login attempts, try again later',
      undefined,
      { retryAfterSeconds: retryAfter },
      { 'Retry-After': String(retryAfter) },
    );
  }
  async login(
    email: string,
    password: string,
    ip: string,
  ): Promise<{ user: AuthUser; token: string; expiresAt: Date }> {
    // Check-and-record atomically: the attempt is stored *before* the password is verified,
    // under per-email and per-IP advisory locks, so parallel guesses cannot all slip through
    // the check. A successful login removes the email's attempts again.
    const attemptId = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'login:email:' + email}))`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'login:ip:' + ip}))`);
      await this.assertNotLimited(tx, email, ip);
      const [attempt] = await tx
        .insert(loginAttempts)
        .values({ email, ip, attemptedAt: this.clock.now() })
        .returning({ id: loginAttempts.id });
      return attempt?.id;
    });
    const [row] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    const ok = row
      ? await verify(row.passwordHash, password).catch(() => false)
      : await this.verifyDummy(password);
    if (!row || !ok) {
      throw new ApiError(401, 'invalid_credentials', 'Invalid email or password');
    }
    await this.db.delete(loginAttempts).where(
      // only this (email, ip) pair is forgiven; other addresses' counters stay untouched
      attemptId === undefined
        ? and(eq(loginAttempts.email, email), eq(loginAttempts.ip, ip))
        : or(
            and(eq(loginAttempts.email, email), eq(loginAttempts.ip, ip)),
            eq(loginAttempts.id, attemptId),
          ),
    );

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(
      this.clock.now().getTime() + this.config.SESSION_TTL_HOURS * 3_600_000,
    );
    await this.db.insert(sessions).values({
      tokenHash: hashToken(token),
      userId: row.id,
      createdAt: this.clock.now(),
      expiresAt,
    });
    return {
      user: {
        id: row.id,
        email: row.email,
        name: row.name,
        role: row.role,
        categories: row.categories,
      },
      token,
      expiresAt,
    };
  }

  async userForToken(token: string): Promise<AuthUser | null> {
    const [row] = await this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        categories: users.categories,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, this.clock.now())),
      )
      .limit(1);
    return row ?? null;
  }

  async logout(token: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
  }

  private async verifyDummy(password: string): Promise<boolean> {
    this.dummyHash ??= hash('dummy-password-for-timing');
    await verify(await this.dummyHash, password).catch(() => false);
    return false;
  }
}
