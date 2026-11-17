import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hash } from '@node-rs/argon2';
import type { Category, Role } from '@helpdesk/shared';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import type { AppConfig } from '../src/config.js';
import { Clock, FakeClock } from '../src/common/clock.js';
import { DB, PG_POOL, type Db } from '../src/db/db.js';
import { users } from '../src/db/schema.js';
import type { Pool } from 'pg';
import { TEST_DATABASE_URL } from './env.js';

export interface TestContext {
  app: INestApplication;
  clock: FakeClock;
  db: Db;
  pool: Pool;
  http: ReturnType<typeof request>;
  close: () => Promise<void>;
}

export async function createTestApp(
  overrides: Partial<AppConfig> = {},
  clock = new FakeClock('2025-01-06T08:00:00.000Z'),
): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        DATABASE_URL: TEST_DATABASE_URL,
        DATABASE_POOL_MAX: 40,
        WORKER_ENABLED: false,
        // throttles are opt-in in tests (a fake clock plus hundreds of requests per user)
        RATE_LIMITS_ENABLED: false,
        ATTACHMENTS_DIR: './data/test-attachments',
        ...overrides,
      }),
    ],
  })
    .overrideProvider(Clock)
    .useValue(clock)
    .compile();
  const app = moduleRef.createNestApplication({ bodyParser: false, logger: ['error', 'warn'] });
  configureApp(app, overrides.TRUST_PROXY);
  await app.init();
  const http = request(app.getHttpServer());
  return {
    app,
    clock,
    db: app.get<Db>(DB),
    pool: app.get<Pool>(PG_POOL),
    http,
    close: () => app.close(),
  };
}

export const PASSWORD = 'secret-pass';
let passwordHash: Promise<string> | undefined;

export interface TestUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  categories: Category[];
}

let seq = 0;
export async function createUser(
  db: Db,
  role: Role,
  categories: Category[] = [],
  name?: string,
): Promise<TestUser> {
  passwordHash ??= hash(PASSWORD);
  seq += 1;
  const email = `${role}${seq}-${Date.now()}@test.io`;
  const [row] = await db
    .insert(users)
    .values({
      email,
      name: name ?? `${role} ${seq}`,
      role,
      categories,
      passwordHash: await passwordHash,
    })
    .returning();
  if (!row) throw new Error('user insert failed');
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    categories: row.categories,
  };
}

/** Logged-in supertest agent (keeps the session cookie). */
export async function loginAs(ctx: TestContext, user: TestUser): Promise<TestAgent> {
  const agent = request.agent(ctx.app.getHttpServer());
  const res = await agent.post('/auth/login').send({ email: user.email, password: PASSWORD });
  if (res.status !== 200)
    throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}
