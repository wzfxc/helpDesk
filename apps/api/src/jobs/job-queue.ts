import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Clock } from '../common/clock.js';
import { DB, type Db } from '../db/db.js';
import type { JobRow } from '../db/schema.js';

export interface EnqueueOptions {
  runAt?: Date;
  /** Unique key: a second enqueue with the same key is a no-op. */
  dedupeKey?: string;
  maxAttempts?: number;
}

interface ClaimedJobDb {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export type ClaimedJob = Pick<JobRow, 'id' | 'type' | 'payload' | 'attempts' | 'maxAttempts'>;

/** Lease length: a job whose worker died becomes claimable again after this. */
export const JOB_LEASE_MS = 5 * 60_000;
export const backoffMs = (attempts: number): number =>
  Math.min(10 * 60_000, 5_000 * 2 ** Math.max(0, attempts - 1));

/**
 * PostgreSQL-backed job queue. Claiming uses FOR UPDATE SKIP LOCKED so any number of
 * workers (also across api instances) never take the same job; a lease (`locked_until`)
 * recovers jobs from crashed workers.
 */
@Injectable()
export class JobQueue {
  readonly workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  async enqueue(
    type: string,
    payload: Record<string, unknown> = {},
    opts: EnqueueOptions = {},
  ): Promise<boolean> {
    const res = await this.db.execute(sql`
      insert into jobs (type, payload, run_at, dedupe_key, max_attempts, created_at)
      values (${type}, ${JSON.stringify(payload)}::jsonb, ${opts.runAt ?? this.clock.now()},
              ${opts.dedupeKey ?? null}, ${opts.maxAttempts ?? 5}, ${this.clock.now()})
      on conflict (dedupe_key) do nothing
      returning id`);
    return res.rows.length > 0;
  }

  async claim(): Promise<ClaimedJob | null> {
    const now = this.clock.now();
    const res = await this.db.execute<ClaimedJobDb & Record<string, unknown>>(sql`
      update jobs set status = 'running', attempts = attempts + 1,
        locked_until = ${new Date(now.getTime() + JOB_LEASE_MS)}, locked_by = ${this.workerId}
      where id = (
        select id from jobs
        where (status = 'queued' and run_at <= ${now})
           or (status = 'running' and locked_until < ${now})
        order by run_at, id
        limit 1
        for update skip locked
      )
      returning id, type, payload, attempts, max_attempts`);
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: r.id,
      type: r.type,
      payload: r.payload,
      attempts: r.attempts,
      maxAttempts: r.max_attempts,
    };
  }

  /** Only the current lease holder may complete a job (a reclaimed job is not double-finished). */
  async complete(job: ClaimedJob): Promise<void> {
    await this.db.execute(sql`
      update jobs set status = 'done', finished_at = ${this.clock.now()}, locked_until = null, last_error = null
      where id = ${job.id} and locked_by = ${this.workerId} and status = 'running'`);
  }

  async fail(job: ClaimedJob, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const now = this.clock.now();
    const final = job.attempts >= job.maxAttempts;
    await this.db.execute(sql`
      update jobs set
        status = ${final ? 'failed' : 'queued'},
        run_at = ${final ? now : new Date(now.getTime() + backoffMs(job.attempts))},
        finished_at = ${final ? now : null},
        locked_until = null,
        last_error = ${message.slice(0, 2000)}
      where id = ${job.id} and locked_by = ${this.workerId} and status = 'running'`);
  }
}
