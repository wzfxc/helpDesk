import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { Clock } from '../common/clock.js';
import { JobHandlers } from './handlers.js';
import { JobQueue, type ClaimedJob } from './job-queue.js';

/** Periodic tasks: one job per type per time slot, keyed by `dedupe_key`. */
export const PERIODIC_TASKS = [
  { type: 'sla-scan', everyMs: 60_000 },
  { type: 'auto-close', everyMs: 5 * 60_000 },
  { type: 'attachment-cleanup', everyMs: 15 * 60_000 },
  { type: 'housekeeping', everyMs: 60 * 60_000 },
] as const;

export const slotKey = (type: string, everyMs: number, now: Date): string =>
  `${type}:${new Date(Math.floor(now.getTime() / everyMs) * everyMs).toISOString()}`;

/**
 * In-process worker + scheduler.
 * - Scheduler: on each tick inserts the current slot's job for every periodic task with
 *   ON CONFLICT (dedupe_key) DO NOTHING, so restarts or several api instances never
 *   schedule a slot twice; handlers catch up on everything due, so skipped slots lose nothing.
 * - Worker: claims with FOR UPDATE SKIP LOCKED + lease, retries with exponential backoff.
 * - Shutdown: stops polling and waits for the job in progress.
 */
@Injectable()
export class JobWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('JobWorker');
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private lastSchedule = 0;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly queue: JobQueue,
    private readonly handlers: JobHandlers,
    private readonly clock: Clock,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.WORKER_ENABLED) this.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    this.logger.log(`worker ${this.queue.workerId} started`);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.wake?.();
    await this.loop;
    this.loop = null;
    this.logger.log('worker stopped');
  }

  /** Inserts the current slot of every periodic task (idempotent). */
  async schedule(): Promise<number> {
    const now = this.clock.now();
    let created = 0;
    for (const task of PERIODIC_TASKS) {
      if (
        await this.queue.enqueue(
          task.type,
          {},
          { dedupeKey: slotKey(task.type, task.everyMs, now), runAt: now },
        )
      ) {
        created += 1;
      }
    }
    return created;
  }

  /** Claims and executes one job; returns false when the queue is empty. */
  async runOnce(): Promise<boolean> {
    const job = await this.queue.claim();
    if (!job) return false;
    try {
      await this.execute(job);
      await this.queue.complete(job);
    } catch (err) {
      this.logger.error(`job ${job.type}#${job.id} failed: ${String(err)}`);
      await this.queue.fail(job, err);
    }
    return true;
  }

  /** Drains the queue (tests, CLI). */
  async drain(max = 1000): Promise<number> {
    let n = 0;
    while (n < max && (await this.runOnce())) n += 1;
    return n;
  }

  private async execute(job: ClaimedJob): Promise<void> {
    switch (job.type) {
      case 'sla-scan':
        await this.handlers.slaScan();
        return;
      case 'auto-close':
        await this.handlers.autoClose();
        return;
      case 'attachment-cleanup':
        await this.handlers.cleanupAttachments();
        return;
      case 'housekeeping':
        await this.handlers.housekeeping();
        return;
      default:
        throw new Error(`unknown job type ${job.type}`);
    }
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        if (Date.now() - this.lastSchedule >= this.config.SCHEDULER_TICK_MS) {
          this.lastSchedule = Date.now();
          await this.schedule();
        }
        if (await this.runOnce()) continue;
      } catch (err) {
        this.logger.error(`worker loop error: ${String(err)}`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.config.WORKER_POLL_MS);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
  }
}
