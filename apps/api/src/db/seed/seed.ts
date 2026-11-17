import { Faker, base, en, uk } from '@faker-js/faker';
import { hash } from '@node-rs/argon2';
import type { Pool } from 'pg';
import {
  DEFAULT_SLA_POLICIES,
  LIMITS,
  type Category,
  type Priority,
  type Status,
} from '@helpdesk/shared';
import { FAR_FUTURE } from '../schema.js';
import { addBusinessMinutes } from '../../sla/business-time.js';
import { computeDeadlines, nextDueAt } from '../../sla/deadlines.js';
import { bulkInsert } from './bulk.js';

export interface SeedOptions {
  tickets: number;
  customers: number;
  passwords: { customer: string; agent: string; lead: string };
  now?: Date;
  log?: (msg: string) => void;
}

export interface SeedResult {
  skipped: boolean;
  tickets: number;
  ms: number;
}

export const SEED_AGENTS: { email: string; name: string; categories: Category[] }[] = [
  { email: 'agent1@helpdesk.local', name: 'Іван Петренко', categories: ['billing', 'account'] },
  { email: 'agent2@helpdesk.local', name: 'Олена Коваль', categories: ['billing', 'delivery'] },
  { email: 'agent3@helpdesk.local', name: 'Андрій Шевчук', categories: ['delivery', 'other'] },
  { email: 'agent4@helpdesk.local', name: 'Марія Бондар', categories: ['technical', 'account'] },
  { email: 'agent5@helpdesk.local', name: 'Тарас Мельник', categories: ['technical', 'other'] },
  { email: 'agent6@helpdesk.local', name: 'Наталія Ткачук', categories: ['technical', 'billing'] },
];
export const SEED_LEAD = { email: 'lead@helpdesk.local', name: 'Оксана Лисенко' };
export const seedCustomerEmail = (i: number) => `customer${i + 1}@example.com`;

const SUBJECTS: Record<Category, string[]> = {
  billing: [
    'Подвійне списання коштів',
    'Не пройшла оплата карткою',
    'Потрібен рахунок-фактура',
    'Refund request for order',
    'Payment declined at checkout',
  ],
  delivery: [
    'Затримка доставки замовлення',
    'Посилка пошкоджена',
    'Змінити адресу доставки',
    'Tracking number does not work',
    'Wrong item delivered',
  ],
  account: [
    'Не можу увійти в акаунт',
    'Змінити email профілю',
    'Видалити обліковий запис',
    'Two-factor code not received',
    'Account locked after password reset',
  ],
  technical: [
    'Помилка 500 при збереженні',
    'Додаток вилітає на Android',
    'Не завантажується сторінка кошика',
    'API returns timeout',
    'Export to CSV is broken',
  ],
  other: [
    'Пропозиція щодо сервісу',
    'Питання про партнерство',
    'Скарга на якість обслуговування',
    'General question about pricing',
    'Feedback on the new design',
  ],
};

const TAGS = ['vip', 'refund', 'bug', 'mobile', 'web', 'urgent-customer', 'b2b', 'repeat', 'promo'];

const CUSTOMER_LINES = [
  'Добрий день! Прошу допомогти якнайшвидше.',
  'Вже другий раз звертаюся з цим питанням.',
  'Hello, could you please look into this?',
  'Додаю деталі: номер замовлення {n}.',
  'Дякую, чекаю на відповідь.',
  'It happened again this morning.',
];
const STAFF_LINES = [
  'Вітаю! Дякуємо за звернення, вже перевіряємо.',
  'Ми передали питання профільній команді.',
  'Hi! We have issued a fix, please check again.',
  'Уточніть, будь ласка, номер замовлення.',
  'Проблему вирішено, повідомте, якщо щось не так.',
];
const NOTE_LINES = [
  'Внутрішнє: клієнт VIP, відповідати пріоритетно.',
  'Internal: escalated to backend team, see JIRA.',
  'Перевірив логи — помилка на боці платіжного шлюзу.',
  'Internal: possible fraud, do not refund without approval.',
];

const CANNED = [
  {
    title: 'Привітання',
    body: 'Вітаю, {{customerName}}! Дякуємо за звернення {{ticketNumber}}. Ми вже працюємо над ним.',
    category: null,
  },
  {
    title: 'Запит деталей',
    body: '{{customerName}}, уточніть, будь ласка, номер замовлення та скріншот помилки ({{ticketNumber}}).',
    category: null,
  },
  {
    title: 'Повернення коштів',
    body: 'Повернення за заявкою {{ticketNumber}} оформлено, кошти надійдуть протягом 3–5 робочих днів.',
    category: 'billing',
  },
  {
    title: 'Доставка затримується',
    body: '{{customerName}}, перепрошуємо за затримку. Нова дата доставки буде повідомлена найближчим часом.',
    category: 'delivery',
  },
  {
    title: 'Скидання пароля',
    body: 'Скористайтеся посиланням «Забули пароль?» на сторінці входу. Заявка {{ticketNumber}}.',
    category: 'account',
  },
  {
    title: 'Hello (EN)',
    body: 'Hi {{customerName}}, thanks for contacting us about {{ticketNumber}}. We are on it.',
    category: null,
  },
] as const;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface TicketSeed {
  id: string;
  number: number;
  subject: string;
  category: Category;
  priority: Priority;
  status: Status;
  customerId: string;
  assigneeId: string | null;
  tags: string[];
  version: number;
  firstResponseDueAt: Date | null;
  resolutionDueAt: Date | null;
  firstRespondedAt: Date | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  nextDueAt: Date | null;
  slaPausedAt: Date | null;
  slaBreachedFirst: boolean;
  slaBreachedResolution: boolean;
  lastMessageAt: Date;
  lastCustomerMessageAt: Date | null;
  lastStaffReplyAt: Date | null;
  ratingScore: number | null;
  ratingComment: string | null;
  ratedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface MessageSeed {
  id: string;
  ticketId: string;
  authorId: string;
  body: string;
  internal: boolean;
  createdAt: Date;
}

interface EventSeed {
  id: string;
  ticketId: string;
  actorId: string | null;
  field: string;
  fromValue: string | null;
  toValue: string | null;
  createdAt: Date;
}

/**
 * Deterministic (fixed faker seed), idempotent (skips when users exist) and fast
 * (bulk unnest inserts in one transaction). Dates are relative to `now`.
 */
export async function seed(pool: Pool, options: SeedOptions): Promise<SeedResult> {
  const started = Date.now();
  const log = options.log ?? (() => undefined);
  const now = options.now ?? new Date();
  const faker = new Faker({ locale: [uk, en, base] });
  faker.seed(20250101);

  const client = await pool.connect();
  try {
    await client.query('begin');
    // Serialise concurrent seeders (e.g. two api replicas starting together).
    await client.query('select pg_advisory_xact_lock(4242)');
    const existing = await client.query<{ count: number }>(
      'select count(*)::int as count from users',
    );
    if ((existing.rows[0]?.count ?? 0) > 0) {
      await client.query('rollback');
      log('seed: data already present, skipping');
      return { skipped: true, tickets: 0, ms: Date.now() - started };
    }

    const [customerHash, agentHash, leadHash] = await Promise.all([
      hash(options.passwords.customer),
      hash(options.passwords.agent),
      hash(options.passwords.lead),
    ]);

    // ---------- users ----------
    const leadId = faker.string.uuid();
    const agents = SEED_AGENTS.map((a) => ({ ...a, id: faker.string.uuid() }));
    const customers = Array.from({ length: options.customers }, (_, i) => ({
      id: faker.string.uuid(),
      email: seedCustomerEmail(i),
      name: `${faker.person.firstName()} ${faker.person.lastName()}`,
    }));
    const userCreated = new Date(now.getTime() - 200 * DAY);
    type U = {
      id: string;
      email: string;
      name: string;
      role: string;
      categories: string[];
      hash: string;
    };
    const users: U[] = [
      {
        id: leadId,
        email: SEED_LEAD.email,
        name: SEED_LEAD.name,
        role: 'lead',
        categories: [],
        hash: leadHash,
      },
      ...agents.map((a) => ({
        id: a.id,
        email: a.email,
        name: a.name,
        role: 'agent',
        categories: a.categories,
        hash: agentHash,
      })),
      ...customers.map((c) => ({
        id: c.id,
        email: c.email,
        name: c.name,
        role: 'customer',
        categories: [],
        hash: customerHash,
      })),
    ];
    await bulkInsert<U>(
      client,
      'users',
      [
        ['id', 'uuid', (u) => u.id],
        ['email', 'text', (u) => u.email],
        ['name', 'text', (u) => u.name],
        ['role', 'text', (u) => u.role],
        ['categories', 'text[]', (u) => u.categories],
        ['password_hash', 'text', (u) => u.hash],
        ['created_at', 'timestamptz', () => userCreated],
      ],
      users,
    );
    log(`seed: ${users.length} users`);

    // ---------- tickets, messages, history ----------
    const policies = new Map(DEFAULT_SLA_POLICIES.map((p) => [p.priority, p]));
    const counterRes = await client.query<{ value: number }>(
      'select value from ticket_counter where id = 1',
    );
    let number = counterRes.rows[0]?.value ?? 1000;

    const tickets: TicketSeed[] = [];
    const messages: MessageSeed[] = [];
    const events: EventSeed[] = [];
    const reads: { userId: string; ticketId: string; lastReadAt: Date }[] = [];
    const pauses: { id: string; ticketId: string; startedAt: Date }[] = [];

    const span = 180 * DAY;
    // Oldest first so numbers grow with creation time.
    const createdTimes = Array.from(
      { length: options.tickets },
      () => now.getTime() - faker.number.int({ min: HOUR, max: span }),
    ).sort((a, b) => a - b);

    for (const createdMs of createdTimes) {
      const createdAt = new Date(createdMs);
      const ageDays = (now.getTime() - createdMs) / DAY;
      const category = faker.helpers.arrayElement(Object.keys(SUBJECTS) as Category[]);
      const priority = faker.helpers.weightedArrayElement<Priority>([
        { value: 'low', weight: 25 },
        { value: 'normal', weight: 45 },
        { value: 'high', weight: 22 },
        { value: 'urgent', weight: 8 },
      ]);
      const status: Status =
        ageDays > 14
          ? faker.helpers.weightedArrayElement<Status>([
              { value: 'closed', weight: 85 },
              { value: 'resolved', weight: 3 },
              { value: 'pending', weight: 4 },
              { value: 'open', weight: 6 },
              { value: 'new', weight: 2 },
            ])
          : ageDays > 3
            ? faker.helpers.weightedArrayElement<Status>([
                { value: 'closed', weight: 30 },
                { value: 'resolved', weight: 20 },
                { value: 'pending', weight: 15 },
                { value: 'open', weight: 25 },
                { value: 'new', weight: 10 },
              ])
            : faker.helpers.weightedArrayElement<Status>([
                { value: 'resolved', weight: 15 },
                { value: 'pending', weight: 15 },
                { value: 'open', weight: 35 },
                { value: 'new', weight: 35 },
              ]);
      const customer = faker.helpers.arrayElement(customers);
      const eligible = agents.filter((a) => a.categories.includes(category));
      const assignee =
        status === 'new' && faker.datatype.boolean(0.8)
          ? null
          : faker.helpers.arrayElement(eligible);
      const policy = policies.get(priority);
      if (!policy) throw new Error(`no SLA policy for ${priority}`);
      const id = faker.string.uuid();
      number += 1;

      const t: TicketSeed = {
        id,
        number,
        subject: `${faker.helpers.arrayElement(SUBJECTS[category])} #${faker.number.int({ min: 1000, max: 99999 })}`,
        category,
        priority,
        status,
        customerId: customer.id,
        assigneeId: assignee?.id ?? null,
        tags: faker.helpers.arrayElements(
          TAGS,
          faker.helpers.weightedArrayElement([
            { value: 0, weight: 50 },
            { value: 1, weight: 35 },
            { value: 2, weight: 15 },
          ]),
        ),
        version: 0,
        firstResponseDueAt: null,
        resolutionDueAt: null,
        firstRespondedAt: null,
        resolvedAt: null,
        closedAt: null,
        nextDueAt: null,
        slaPausedAt: null,
        slaBreachedFirst: false,
        slaBreachedResolution: false,
        lastMessageAt: createdAt,
        lastCustomerMessageAt: createdAt,
        lastStaffReplyAt: null,
        ratingScore: null,
        ratingComment: null,
        ratedAt: null,
        createdAt,
        updatedAt: createdAt,
      };
      const due = computeDeadlines(createdAt, policy, []);
      t.firstResponseDueAt = due.firstResponseDueAt;
      t.resolutionDueAt = due.resolutionDueAt;

      const event = (
        field: string,
        from: string | null,
        to: string | null,
        at: Date,
        actor: string | null,
      ) => {
        events.push({
          id: faker.string.uuid(),
          ticketId: id,
          actorId: actor,
          field,
          fromValue: from,
          toValue: to,
          createdAt: at,
        });
        t.version += 1;
        t.updatedAt = at > t.updatedAt ? at : t.updatedAt;
      };
      const message = (authorId: string, body: string, internal: boolean, at: Date) => {
        messages.push({
          id: faker.string.uuid(),
          ticketId: id,
          authorId,
          body,
          internal,
          createdAt: at,
        });
        if (at > t.lastMessageAt) t.lastMessageAt = at;
        if (at > t.updatedAt) t.updatedAt = at;
      };
      const clamp = (d: Date) =>
        d.getTime() > now.getTime() - 60_000 ? new Date(now.getTime() - 60_000) : d;

      message(
        customer.id,
        `${faker.helpers.arrayElement(CUSTOMER_LINES).replace('{n}', String(faker.number.int({ min: 10000, max: 99999 })))} ${faker.lorem.sentence()}`,
        false,
        createdAt,
      );

      let cursor = createdAt;
      if (assignee) {
        const at = clamp(new Date(createdMs + faker.number.int({ min: 60_000, max: 2 * HOUR })));
        event('assignee', null, assignee.id, at, status === 'new' ? leadId : assignee.id);
        cursor = at;
      }

      if (status !== 'new' && assignee) {
        // First response: mostly within SLA, ~12% late.
        const late = faker.datatype.boolean(0.12);
        const budget = late
          ? policy.firstResponseMinutes + faker.number.int({ min: 30, max: 600 })
          : faker.number.int({ min: 5, max: Math.max(6, policy.firstResponseMinutes - 5) });
        const respondedAt = clamp(addBusinessMinutes(createdAt, budget) ?? cursor);
        const at = respondedAt < cursor ? cursor : respondedAt;
        if (faker.datatype.boolean(0.3)) {
          message(
            assignee.id,
            faker.helpers.arrayElement(NOTE_LINES),
            true,
            new Date(
              at.getTime() - 60_000 > cursor.getTime() ? at.getTime() - 60_000 : at.getTime(),
            ),
          );
        }
        message(assignee.id, faker.helpers.arrayElement(STAFF_LINES), false, at);
        t.firstRespondedAt = at;
        t.lastStaffReplyAt = at;
        event('status', 'new', 'open', at, assignee.id);
        cursor = at;
        if (t.firstResponseDueAt && at > t.firstResponseDueAt) t.slaBreachedFirst = true;

        if (faker.datatype.boolean(0.5)) {
          const custAt = clamp(
            new Date(cursor.getTime() + faker.number.int({ min: 10 * 60_000, max: DAY })),
          );
          if (custAt > cursor) {
            message(
              customer.id,
              faker.helpers.arrayElement(CUSTOMER_LINES).replace('{n}', '42'),
              false,
              custAt,
            );
            t.lastCustomerMessageAt = custAt;
            cursor = custAt;
          }
        }

        if (status === 'pending') {
          const at2 = clamp(
            new Date(cursor.getTime() + faker.number.int({ min: 5 * 60_000, max: 6 * HOUR })),
          );
          message(
            assignee.id,
            'Уточніть, будь ласка, деталі — чекаємо на вашу відповідь.',
            false,
            at2,
          );
          t.lastStaffReplyAt = at2;
          event('status', 'open', 'pending', at2, assignee.id);
          t.slaPausedAt = at2;
          pauses.push({ id: faker.string.uuid(), ticketId: id, startedAt: at2 });
        }

        if (status === 'resolved' || status === 'closed') {
          const lateRes = faker.datatype.boolean(0.15);
          const budget2 = lateRes
            ? policy.resolutionMinutes + faker.number.int({ min: 30, max: 1200 })
            : faker.number.int({
                min: Math.min(budget + 5, policy.resolutionMinutes - 1),
                max: policy.resolutionMinutes - 1,
              });
          let resolvedAt = clamp(addBusinessMinutes(createdAt, budget2) ?? cursor);
          if (resolvedAt <= cursor) resolvedAt = clamp(new Date(cursor.getTime() + 5 * 60_000));
          message(
            assignee.id,
            'Проблему вирішено. Якщо питання залишились — просто відповідайте на цей лист.',
            false,
            resolvedAt,
          );
          t.lastStaffReplyAt = resolvedAt;
          event('status', 'open', 'resolved', resolvedAt, assignee.id);
          t.resolvedAt = resolvedAt;
          if (t.resolutionDueAt && resolvedAt > t.resolutionDueAt) t.slaBreachedResolution = true;
          cursor = resolvedAt;
          if (status === 'resolved') {
            t.slaPausedAt = resolvedAt;
            pauses.push({ id: faker.string.uuid(), ticketId: id, startedAt: resolvedAt });
          }
          if (faker.datatype.boolean(0.6)) {
            t.ratingScore = faker.helpers.weightedArrayElement([
              { value: 5, weight: 45 },
              { value: 4, weight: 25 },
              { value: 3, weight: 15 },
              { value: 2, weight: 8 },
              { value: 1, weight: 7 },
            ]);
            t.ratingComment = faker.datatype.boolean(0.4) ? faker.lorem.sentence() : null;
            t.ratedAt = clamp(
              new Date(resolvedAt.getTime() + faker.number.int({ min: 60_000, max: DAY })),
            );
          }
          if (status === 'closed') {
            const closedAt = new Date(
              resolvedAt.getTime() +
                LIMITS.autoCloseDays * DAY +
                faker.number.int({ min: 0, max: HOUR }),
            );
            t.closedAt = closedAt > now ? now : closedAt;
            event('status', 'resolved', 'closed', t.closedAt, null);
          }
        }
      }

      if (faker.datatype.boolean(0.05) && status !== 'new') {
        const from = t.priority;
        const to: Priority = from === 'urgent' ? 'high' : 'urgent';
        event('priority', from, to, new Date(createdMs + 30_000), assignee?.id ?? leadId);
        t.priority = to;
        const d2 = computeDeadlines(createdAt, policies.get(to) ?? policy, []);
        t.firstResponseDueAt = d2.firstResponseDueAt;
        t.resolutionDueAt = d2.resolutionDueAt;
        t.slaBreachedFirst = !!(
          t.firstRespondedAt &&
          d2.firstResponseDueAt &&
          t.firstRespondedAt > d2.firstResponseDueAt
        );
        t.slaBreachedResolution = !!(
          t.resolvedAt &&
          d2.resolutionDueAt &&
          t.resolvedAt > d2.resolutionDueAt
        );
      }

      t.nextDueAt = nextDueAt(t);
      // Running timers already past due are breaches (what the SLA job would have flagged).
      if (t.nextDueAt && t.nextDueAt < now) {
        if (!t.firstRespondedAt) t.slaBreachedFirst = true;
        else t.slaBreachedResolution = true;
      }

      // Customers have read everything except (some of) the latest replies.
      if (faker.datatype.boolean(t.status === 'closed' ? 0.98 : 0.6)) {
        reads.push({ userId: customer.id, ticketId: id, lastReadAt: t.lastMessageAt });
      }
      if (t.assigneeId)
        reads.push({ userId: t.assigneeId, ticketId: id, lastReadAt: t.lastMessageAt });
      tickets.push(t);
    }

    await bulkInsert<TicketSeed>(
      client,
      'tickets',
      [
        ['id', 'uuid', (t) => t.id],
        ['number', 'int4', (t) => t.number],
        ['subject', 'text', (t) => t.subject],
        ['category', 'text', (t) => t.category],
        ['priority', 'text', (t) => t.priority],
        ['status', 'text', (t) => t.status],
        ['customer_id', 'uuid', (t) => t.customerId],
        ['assignee_id', 'uuid', (t) => t.assigneeId],
        ['tags', 'text[]', (t) => t.tags],
        ['version', 'int4', (t) => t.version],
        ['first_response_due_at', 'timestamptz', (t) => t.firstResponseDueAt],
        ['resolution_due_at', 'timestamptz', (t) => t.resolutionDueAt],
        ['first_responded_at', 'timestamptz', (t) => t.firstRespondedAt],
        ['resolved_at', 'timestamptz', (t) => t.resolvedAt],
        ['closed_at', 'timestamptz', (t) => t.closedAt],
        ['next_due_at', 'timestamptz', (t) => t.nextDueAt],
        ['sla_sort_at', 'timestamptz', (t) => t.nextDueAt ?? FAR_FUTURE],
        ['sla_paused_at', 'timestamptz', (t) => t.slaPausedAt],
        ['sla_breached_first', 'bool', (t) => t.slaBreachedFirst],
        ['sla_breached_resolution', 'bool', (t) => t.slaBreachedResolution],
        ['last_message_at', 'timestamptz', (t) => t.lastMessageAt],
        ['last_customer_message_at', 'timestamptz', (t) => t.lastCustomerMessageAt],
        ['last_staff_reply_at', 'timestamptz', (t) => t.lastStaffReplyAt],
        ['rating_score', 'int2', (t) => t.ratingScore],
        ['rating_comment', 'text', (t) => t.ratingComment],
        ['rated_at', 'timestamptz', (t) => t.ratedAt],
        ['created_at', 'timestamptz', (t) => t.createdAt],
        ['updated_at', 'timestamptz', (t) => t.updatedAt],
      ],
      tickets,
      2000,
    );
    log(`seed: ${tickets.length} tickets`);

    await bulkInsert<MessageSeed>(
      client,
      'messages',
      [
        ['id', 'uuid', (m) => m.id],
        ['ticket_id', 'uuid', (m) => m.ticketId],
        ['author_id', 'uuid', (m) => m.authorId],
        ['body', 'text', (m) => m.body],
        ['internal', 'bool', (m) => m.internal],
        ['created_at', 'timestamptz', (m) => m.createdAt],
      ],
      messages,
    );
    log(`seed: ${messages.length} messages`);

    await bulkInsert<EventSeed>(
      client,
      'ticket_events',
      [
        ['id', 'uuid', (e) => e.id],
        ['ticket_id', 'uuid', (e) => e.ticketId],
        ['actor_id', 'uuid', (e) => e.actorId],
        ['field', 'text', (e) => e.field],
        ['from_value', 'text', (e) => e.fromValue],
        ['to_value', 'text', (e) => e.toValue],
        ['created_at', 'timestamptz', (e) => e.createdAt],
      ],
      events,
    );
    await bulkInsert(
      client,
      'ticket_reads',
      [
        ['user_id', 'uuid', (r: (typeof reads)[number]) => r.userId],
        ['ticket_id', 'uuid', (r) => r.ticketId],
        ['last_read_at', 'timestamptz', (r) => r.lastReadAt],
      ],
      reads,
    );
    await bulkInsert(
      client,
      'sla_pauses',
      [
        ['id', 'uuid', (p: (typeof pauses)[number]) => p.id],
        ['ticket_id', 'uuid', (p) => p.ticketId],
        ['started_at', 'timestamptz', (p) => p.startedAt],
      ],
      pauses,
    );
    log(`seed: ${events.length} events, ${reads.length} reads, ${pauses.length} pauses`);

    // Counter = last used number: no gaps, the next ticket continues the sequence.
    await client.query('update ticket_counter set value = $1 where id = 1', [number]);

    for (const c of CANNED) {
      await client.query(
        'insert into canned_responses (id, title, body, category, created_by) values ($1, $2, $3, $4, $5)',
        [faker.string.uuid(), c.title, c.body, c.category, leadId],
      );
    }
    for (const a of agents) {
      await client.query(
        'insert into saved_views (id, user_id, name, query) values ($1, $2, $3, $4)',
        [
          faker.string.uuid(),
          a.id,
          'Мої термінові',
          'assignee=me&priority=high,urgent&status=new,open,pending&sort=sla',
        ],
      );
    }

    await client.query('commit');
    const ms = Date.now() - started;
    log(`seed: done in ${ms} ms`);
    return { skipped: false, tickets: tickets.length, ms };
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
