/**
 * List/search benchmark on the seeded database (20k tickets).
 * Runs every typical list query through the same SQL builder the API uses, prints
 * EXPLAIN (ANALYZE, BUFFERS) execution times and exits non-zero if any query is slower
 * than the budget. Usage: DATABASE_URL=… pnpm --filter @helpdesk/api bench
 */
import { PgDialect } from 'drizzle-orm/pg-core';
import { TicketListQuerySchema, type TicketListQueryInput } from '@helpdesk/shared';
import type { AuthUser } from '../auth/auth.types.js';
import { loadConfig } from '../config.js';
import { createDb, createPool } from '../db/db.js';
import { runMigrations } from '../db/migrate.js';
import { seed } from '../db/seed/seed.js';
import { encodeCursor, listQueryOptions, listTickets } from '../tickets/ticket-list.js';
import { ticketsQuery } from '../tickets/ticket-query.js';

const BUDGET_MS = Number(process.env.BENCH_BUDGET_MS ?? 200);
const RUNS = 5;

interface Scenario {
  name: string;
  viewer: 'lead' | 'agent' | 'customer';
  query: TicketListQueryInput;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL, 4);
  const db = createDb(pool);
  const dialect = new PgDialect();
  try {
    await runMigrations(pool);
    const count = await pool.query<{ n: number }>('select count(*)::int as n from tickets');
    if ((count.rows[0]?.n ?? 0) === 0) {
      console.log('database is empty, seeding…');
      await seed(pool, {
        tickets: config.SEED_TICKETS,
        customers: 200,
        passwords: {
          customer: config.SEED_CUSTOMER_PASSWORD,
          agent: config.SEED_AGENT_PASSWORD,
          lead: config.SEED_LEAD_PASSWORD,
        },
      });
    }
    await pool.query('analyze');
    const total = (await pool.query<{ n: number }>('select count(*)::int as n from tickets'))
      .rows[0]?.n;
    console.log(`tickets: ${total}`);

    const user = async (email: string): Promise<AuthUser> => {
      const r = await pool.query<AuthUser>(
        'select id, email, name, role, categories from users where email = $1',
        [email],
      );
      const u = r.rows[0];
      if (!u) throw new Error(`seed user ${email} not found`);
      return u;
    };
    const viewers = {
      lead: await user('lead@helpdesk.local'),
      agent: await user('agent1@helpdesk.local'),
      customer: await user('customer1@example.com'),
    };

    // Cursor ~10 000 rows deep for the "deep page" scenarios.
    const deep = await pool.query<{ v: string; id: string }>(
      `select sla_sort_at::text as v, id from tickets order by sla_sort_at, id offset 10000 limit 1`,
    );
    const deepCreated = await pool.query<{ v: string; id: string }>(
      `select created_at::text as v, id from tickets order by created_at desc, id desc offset 10000 limit 1`,
    );
    const since = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();

    const scenarios: Scenario[] = [
      { name: 'lead: default (sla)', viewer: 'lead', query: {} },
      { name: 'lead: sort -created', viewer: 'lead', query: { sort: '-created' } },
      { name: 'lead: sort created', viewer: 'lead', query: { sort: 'created' } },
      { name: 'lead: sort -updated', viewer: 'lead', query: { sort: '-updated' } },
      { name: 'lead: sort updated', viewer: 'lead', query: { sort: 'updated' } },
      { name: 'lead: sort -sla', viewer: 'lead', query: { sort: '-sla' } },
      { name: 'lead: status=open', viewer: 'lead', query: { status: 'open' } },
      {
        name: 'lead: status=new,open,pending',
        viewer: 'lead',
        query: { status: 'new,open,pending' },
      },
      { name: 'lead: priority=urgent', viewer: 'lead', query: { priority: 'urgent' } },
      { name: 'lead: category=technical', viewer: 'lead', query: { category: 'technical' } },
      { name: 'lead: assignee=none', viewer: 'lead', query: { assignee: 'none' } },
      { name: 'lead: slaBreached=true', viewer: 'lead', query: { slaBreached: 'true' } },
      { name: 'lead: slaRisk=true', viewer: 'lead', query: { slaRisk: 'true' } },
      { name: 'lead: tags=vip', viewer: 'lead', query: { tags: 'vip' } },
      { name: 'lead: tags=vip,refund', viewer: 'lead', query: { tags: 'vip,refund' } },
      {
        name: 'lead: created last 30d',
        viewer: 'lead',
        query: { createdFrom: since, sort: '-created' },
      },
      {
        name: 'lead: combined filters',
        viewer: 'lead',
        query: { status: 'new,open', category: 'billing', priority: 'high,urgent', sort: 'sla' },
      },
      { name: 'lead: search subject word', viewer: 'lead', query: { q: 'доставки' } },
      { name: 'lead: search prefix', viewer: 'lead', query: { q: 'refund' } },
      { name: 'lead: search message text', viewer: 'lead', query: { q: 'передали команді' } },
      { name: 'lead: search frequent word', viewer: 'lead', query: { q: 'будь' } },
      { name: 'lead: search number', viewer: 'lead', query: { q: 'HD-12345' } },
      { name: 'lead: search + filter', viewer: 'lead', query: { q: 'оплата', status: 'closed' } },
      {
        name: 'lead: deep page (sla, ~10k)',
        viewer: 'lead',
        query: deep.rows[0]
          ? { cursor: encodeCursor({ s: 'sla', v: deep.rows[0].v, id: deep.rows[0].id }) }
          : {},
      },
      {
        name: 'lead: deep page (-created, ~10k)',
        viewer: 'lead',
        query: deepCreated.rows[0]
          ? {
              sort: '-created',
              cursor: encodeCursor({
                s: '-created',
                v: deepCreated.rows[0].v,
                id: deepCreated.rows[0].id,
              }),
            }
          : {},
      },
      { name: 'agent: default (sla)', viewer: 'agent', query: {} },
      {
        name: 'agent: my open',
        viewer: 'agent',
        query: { assignee: 'me', status: 'new,open,pending' },
      },
      {
        name: 'agent: unassigned',
        viewer: 'agent',
        query: { assignee: 'none', status: 'new,open' },
      },
      { name: 'agent: sla hot', viewer: 'agent', query: { slaRisk: 'true' } },
      { name: 'agent: search', viewer: 'agent', query: { q: 'оплата' } },
      { name: 'agent: sort -updated', viewer: 'agent', query: { sort: '-updated' } },
      { name: 'customer: default (-updated)', viewer: 'customer', query: {} },
      { name: 'customer: search', viewer: 'customer', query: { q: 'замовлення' } },
      { name: 'customer: status=closed', viewer: 'customer', query: { status: 'closed' } },
    ];

    const now = new Date();
    const results: { name: string; execMs: number; wallMs: number; rows: number }[] = [];
    for (const s of scenarios) {
      const viewer = viewers[s.viewer];
      const query = TicketListQuerySchema.parse(s.query);
      const opts = listQueryOptions(viewer, query, now);
      const compiled = dialect.sqlToQuery(ticketsQuery(viewer, opts));
      const plan = await pool.query<{ 'QUERY PLAN': { 'Execution Time': number }[] }>(
        `explain (analyze, buffers, format json) ${compiled.sql}`,
        compiled.params,
      );
      const execMs = plan.rows[0]?.['QUERY PLAN'][0]?.['Execution Time'] ?? Number.NaN;
      const walls: number[] = [];
      let rows = 0;
      for (let i = 0; i < RUNS; i++) {
        const t0 = performance.now();
        const page = await listTickets(db, viewer, query, now);
        walls.push(performance.now() - t0);
        rows = page.items.length;
      }
      walls.sort((a, b) => a - b);
      results.push({ name: s.name, execMs, wallMs: walls[Math.floor(RUNS / 2)] ?? 0, rows });
    }

    console.log('\n| scenario | rows | EXPLAIN exec ms | median wall ms |');
    console.log('| --- | ---: | ---: | ---: |');
    for (const r of results) {
      console.log(`| ${r.name} | ${r.rows} | ${r.execMs.toFixed(2)} | ${r.wallMs.toFixed(2)} |`);
    }
    const slow = results.filter((r) => r.wallMs > BUDGET_MS || r.execMs > BUDGET_MS);
    const worst = Math.max(...results.map((r) => r.wallMs));
    console.log(`\nworst median wall time: ${worst.toFixed(2)} ms (budget ${BUDGET_MS} ms)`);

    if (process.argv.includes('--indexes')) {
      const idx = await pool.query<{ indexname: string; indexdef: string }>(
        `select indexname, indexdef from pg_indexes
         where schemaname = 'public' and tablename in ('tickets', 'messages') order by tablename, indexname`,
      );
      for (const i of idx.rows) console.log(`${i.indexname}: ${i.indexdef}`);
    }
    if (slow.length) {
      console.error(`\nFAILED: ${slow.map((s) => s.name).join(', ')}`);
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
