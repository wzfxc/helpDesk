import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().default('postgres://helpdesk:helpdesk@localhost:5432/helpdesk'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(20),
  COOKIE_SECURE: bool.default(false),
  /** express 'trust proxy' value: which hops may set X-Forwarded-For. */
  TRUST_PROXY: z.string().default('loopback, linklocal, uniquelocal'),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(168),
  ATTACHMENTS_DIR: z.string().default('./data/attachments'),
  WORKER_ENABLED: bool.default(true),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(1000),
  SCHEDULER_TICK_MS: z.coerce.number().int().positive().default(15_000),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  LOGIN_MAX_FAILURES: z.coerce.number().int().positive().default(5),
  LOGIN_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
  /** Failures per account from ALL addresses (distributed guessing). Default 10x LOGIN_MAX_FAILURES. */
  LOGIN_EMAIL_MAX_FAILURES: z.coerce.number().int().positive().optional(),
  /** Failures per address across ALL accounts (flood guard). Default 40x LOGIN_MAX_FAILURES. */
  LOGIN_IP_MAX_FAILURES: z.coerce.number().int().positive().optional(),
  /** Per-user throttles on typing / ticket creation / messages / uploads (429 + Retry-After). */
  RATE_LIMITS_ENABLED: bool.default(true),
  SEED_ON_START: bool.default(false),
  SEED_TICKETS: z.coerce.number().int().nonnegative().default(20_000),
  SEED_CUSTOMER_PASSWORD: z.string().min(1).default('customer123'),
  SEED_AGENT_PASSWORD: z.string().min(1).default('agent123'),
  SEED_LEAD_PASSWORD: z.string().min(1).default('lead123'),
  SLA_HOLIDAYS: z.string().default(''),
  ENABLE_TEST_HOOKS: bool.default(false),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export const APP_CONFIG = Symbol('APP_CONFIG');
