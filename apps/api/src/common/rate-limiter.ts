import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from './errors.js';
import { APP_CONFIG, type AppConfig } from '../config.js';

export interface RateRule {
  max: number;
  windowMs: number;
}

/**
 * Per-key sliding-window throttle for abuse-prone endpoints (typing, ticket creation, messages,
 * uploads). In memory and per api instance: it protects one process from a runaway client, it is
 * not a distributed quota. Uses wall-clock time on purpose (not the injectable business Clock).
 */
@Injectable()
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private sweepAt = 0;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** Records one hit for `key` under `bucket`; throws 429 + Retry-After when over the rule. */
  check(bucket: string, key: string, rule: RateRule, now = Date.now()): void {
    if (!this.config.RATE_LIMITS_ENABLED) return;
    this.sweep(now, rule.windowMs);
    const id = `${bucket}:${key}`;
    const recent = (this.hits.get(id) ?? []).filter((t) => t > now - rule.windowMs);
    if (recent.length >= rule.max) {
      const oldest = recent[0] ?? now;
      const retryAfter = Math.max(1, Math.ceil((oldest + rule.windowMs - now) / 1000));
      this.hits.set(id, recent);
      throw new ApiError(
        429,
        'rate_limited',
        'Too many requests, slow down',
        undefined,
        { retryAfterSeconds: retryAfter },
        { 'Retry-After': String(retryAfter) },
      );
    }
    recent.push(now);
    this.hits.set(id, recent);
  }

  /** Drops expired keys now and then so the map cannot grow without bound. */
  private sweep(now: number, windowMs: number): void {
    if (now < this.sweepAt) return;
    this.sweepAt = now + 60_000;
    for (const [id, times] of this.hits) {
      if ((times[times.length - 1] ?? 0) <= now - Math.max(windowMs, 600_000)) this.hits.delete(id);
    }
  }
}
