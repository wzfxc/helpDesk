# Helpdesk

Монорепозиторій системи підтримки клієнтів (NestJS + PostgreSQL 16 + Drizzle + Next.js 15 App Router + TypeScript strict).

```text
apps/api         — NestJS REST API, SSE (LISTEN/NOTIFY), фонові задачі на PostgreSQL
apps/web         — Next.js (App Router), кабінет клієнта, робоче місце агента і керівника
packages/shared  — спільні Zod-схеми, enum-и, матриця переходів, SLA-дефолти, контракти помилок
e2e              — Playwright (+ @axe-core/playwright) проти Docker Compose стеку
```

---

## 1. Запуск і тести

### Швидкий старт у Docker Compose

Єдиний ручний крок:

```bash
cp .env.example .env
docker compose up -d --build --wait
```

Сервіси:

- `web` — `http://localhost:3000` (проксує `/api/*` на `http://api:4000`, тому session cookie працює як same-origin без CORS).
- `api` — `http://localhost:4000` (Swagger на `/docs`, проби `GET /health` і `GET /ready`).
- `postgres` — `postgres:16` на порту `5432` (вкладення зберігаються в Docker volume `attachments`, при старті автоматично виконуються міграції Drizzle та сид `20 000` заявок, якщо БД порожня).

Зупинка: `docker compose down` (або `docker compose down -v` для скидання БД і вкладень).

### Локальна розробка (без Docker для api/web)

Потрібен Node.js `>= 22`, `pnpm@12.21.0` та PostgreSQL 16:

```bash
pnpm install
cp .env.example .env
docker compose up -d postgres --wait
pnpm build:shared
pnpm db:migrate
pnpm db:seed
pnpm --filter @helpdesk/api dev
pnpm --filter @helpdesk/web dev
```

### Перевірки та тести

```bash
pnpm format:check     # Prettier
pnpm lint             # build:shared + ESLint (--max-warnings=0)
pnpm typecheck        # tsc --noEmit у всіх пакетах
pnpm db:test:up       # одноразовий PostgreSQL 16 на порту 5433 (tmpfs)
pnpm test             # shared (unit) + api (unit + інтеграційні на PostgreSQL 16) + web
pnpm test:e2e         # Playwright проти запущеного docker compose стеку
pnpm --filter @helpdesk/api bench   # бенчмарк запитів списку на 20 000 заявках
```

---

## 2. Тестові акаунти (Seed)

Сід (`apps/api/src/db/seed/seed.ts`) детермінований (`faker.seed(20250101)`), ідемпотентний і створює:

- **1 lead**, **6 агентів**, **200 клієнтів**,
- **20 000 заявок** за останні 180 днів в усіх статусах (нумерація з `HD-1001`), повідомлення, історію, паузи SLA, 6 шаблонів відповідей і 1 збережене представлення на кожного агента.

| Роль       | Email                                                | Пароль        | Категорії / Примітки                                        |
| ---------- | ---------------------------------------------------- | ------------- | ----------------------------------------------------------- |
| `lead`     | `lead@helpdesk.local`                                | `lead123`     | Оксана Лисенко; бачить усі заявки, SLA, шаблони, статистику |
| `agent`    | `agent1@helpdesk.local`                              | `agent123`    | Іван Петренко — `billing`, `account`                        |
| `agent`    | `agent2@helpdesk.local`                              | `agent123`    | Олена Коваль — `billing`, `delivery`                        |
| `agent`    | `agent3@helpdesk.local`                              | `agent123`    | Андрій Шевчук — `delivery`, `other`                         |
| `agent`    | `agent4@helpdesk.local`                              | `agent123`    | Марія Бондар — `technical`, `account`                       |
| `agent`    | `agent5@helpdesk.local`                              | `agent123`    | Тарас Мельник — `technical`, `other`                        |
| `agent`    | `agent6@helpdesk.local`                              | `agent123`    | Наталія Ткачук — `technical`, `billing`                     |
| `customer` | `customer1@example.com` .. `customer200@example.com` | `customer123` | Бачить лише власні заявки                                   |

---

## 3. Таблиця переходів статусів

Єдине джерело правди для бекенду та UI — `TRANSITIONS` і `statusAfterMessage` у [`packages/shared/src/transitions.ts`](packages/shared/src/transitions.ts).

| З (`from`) | В (`to`)   | Тригер (`trigger`)    | Хто (`actors`)  | Як викликається                                          |
| ---------- | ---------- | --------------------- | --------------- | -------------------------------------------------------- |
| `new`      | `open`     | `staff_manual`        | `agent`, `lead` | `PATCH /tickets/:id`, `POST /tickets/bulk`               |
| `new`      | `pending`  | `staff_manual`        | `agent`, `lead` | `PATCH /tickets/:id`, `POST /tickets/bulk`               |
| `new`      | `resolved` | `staff_manual`        | `agent`, `lead` | `PATCH /tickets/:id`, `POST /tickets/bulk`               |
| `open`     | `pending`  | `staff_manual`        | `agent`, `lead` | `PATCH /tickets/:id`, `POST /tickets/bulk`               |
| `open`     | `resolved` | `staff_manual`        | `agent`, `lead` | `PATCH /tickets/:id`, `POST /tickets/bulk`               |
| `pending`  | `open`     | `staff_manual`        | `agent`, `lead` | `PATCH /tickets/:id`, `POST /tickets/bulk`               |
| `pending`  | `resolved` | `staff_manual`        | `agent`, `lead` | `PATCH /tickets/:id`, `POST /tickets/bulk`               |
| `resolved` | `open`     | `staff_manual`        | `agent`, `lead` | `PATCH /tickets/:id`, `POST /tickets/bulk`               |
| `resolved` | `closed`   | `staff_manual`        | `agent`, `lead` | `PATCH /tickets/:id`, `POST /tickets/bulk`               |
| `new`      | `open`     | `staff_public_reply`  | `agent`, `lead` | Публічна відповідь (`POST /tickets/:id/messages`)        |
| `pending`  | `open`     | `staff_public_reply`  | `agent`, `lead` | Публічна відповідь (`POST /tickets/:id/messages`)        |
| `new`      | `pending`  | `staff_reply_pending` | `agent`, `lead` | Відповідь з `followUp: "pending"`                        |
| `open`     | `pending`  | `staff_reply_pending` | `agent`, `lead` | Відповідь з `followUp: "pending"`                        |
| `resolved` | `pending`  | `staff_reply_pending` | `agent`, `lead` | Відповідь з `followUp: "pending"`                        |
| `new`      | `resolved` | `staff_reply_resolve` | `agent`, `lead` | Відповідь з `followUp: "resolved"`                       |
| `open`     | `resolved` | `staff_reply_resolve` | `agent`, `lead` | Відповідь з `followUp: "resolved"`                       |
| `pending`  | `resolved` | `staff_reply_resolve` | `agent`, `lead` | Відповідь з `followUp: "resolved"`                       |
| `pending`  | `open`     | `customer_reply`      | `customer`      | Відповідь клієнта (`POST /tickets/:id/messages`)         |
| `resolved` | `open`     | `customer_reply`      | `customer`      | Відповідь клієнта (`POST /tickets/:id/messages`)         |
| `new`      | `resolved` | `customer_resolve`    | `customer`      | Кнопка «Проблема вирішена» (`POST /tickets/:id/resolve`) |
| `open`     | `resolved` | `customer_resolve`    | `customer`      | Кнопка «Проблема вирішена» (`POST /tickets/:id/resolve`) |
| `pending`  | `resolved` | `customer_resolve`    | `customer`      | Кнопка «Проблема вирішена» (`POST /tickets/:id/resolve`) |
| `resolved` | `closed`   | `auto_close`          | `system`        | Фонова задача через 3 дні без відповіді клієнта          |

Додаткові правила:

- **Внутрішні нотатки (`internal: true`)** ніколи не змінюють статус.
- **Звичайна публічна відповідь співробітника** у `open` або `resolved`, або відповідь клієнта у `new` чи `open` не змінює статус (`keep`).
- **Закрита заявка (`closed`) термінальна**: зміни через `PATCH`, `bulk` і повідомлення співробітника відхиляються з `422 ticket_closed`. Відповідь **клієнта** на `closed` (`spawn`) створює нову заявку зі статусом `new`, `parentTicketId` = id закритої заявки, тією ж темою, категорією та пріоритетом, і повертає `newTicketId`.

---

## 4. Розрахунок SLA

Реалізація: `apps/api/src/sla/business-time.ts`, `deadlines.ts`, `sla.service.ts`.

### Календар і політики за замовчуванням

- Робочий час: **пн–пт, 09:00–18:00** за часовою зоною **`Europe/Kyiv`** (`@date-fns/tz`, з коректним урахуванням переходу на літній/зимовий час). 1 робочий день = `540` хв.
- Дефолтні політики (таблиця `sla_policies`, ініціалізується в `0001_bootstrap.sql`, редагується через `PUT /sla-policies` роллю `lead`):

| Пріоритет | Перша відповідь      | Вирішення             |
| --------- | -------------------- | --------------------- |
| `urgent`  | 60 хв (1 год)        | 240 хв (4 год)        |
| `high`    | 240 хв (4 год)       | 540 хв (1 роб. день)  |
| `normal`  | 540 хв (1 роб. день) | 1620 хв (3 роб. дні)  |
| `low`     | 1080 хв (2 роб. дні) | 2700 хв (5 роб. днів) |

### Алгоритм

1. Обидва дедлайни (`firstResponseDueAt`, `resolutionDueAt`) завжди рахуються від **`createdAt`** додаванням робочих хвилин політики з виключенням усіх пауз із `sla_pauses`.
2. Перехід у статус паузи (`pending`, `resolved`, `closed`) записує відкритий інтервал у `sla_pauses` (`ended_at IS NULL`, обмежено унікальним частковим індексом `sla_pauses_open_uq`) і скидає `next_due_at = NULL` (`sla_sort_at = '9999-12-31T00:00:00.000Z'`).
3. Повернення з паузи в `new` або `open` закриває інтервал (`ended_at = now`) і перераховує дедлайни від `createdAt` з урахуванням усіх накопичених пауз.
4. **Зміна пріоритету** перераховує обидва дедлайни від `createdAt` за політикою нового пріоритету та перераховує прапорці `slaBreachedFirst` / `slaBreachedResolution`.
5. Зміна SLA-політики (`PUT /sla-policies`) впливає на нові заявки та на заявки, у яких згодом зміниться пріоритет.

### Приклад: заявка `high` у п’ятницю о 17:00 (`Europe/Kyiv`)

Для `high` бюджет становить `240` робочих хвилин (перша відповідь) і `540` робочих хвилин (вирішення):

- У п’ятницю з 17:00 до 18:00 доступно **`60` хв**. Субота і неділя пропускаються.
- **Перша відповідь (`240` хв):** `60` хв у пт + `180` хв у пн (09:00–12:00) → **понеділок 12:00** (Europe/Kyiv).
- **Вирішення (`540` хв):** `60` хв у пт + `480` хв у пн (09:00–17:00) → **понеділок 17:00** (Europe/Kyiv).
- **З паузою у `pending` в пн 09:00–10:30 (`90` роб. хв):**
  - перша відповідь зсувається на 90 хв → **понеділок 13:30**;
  - вирішення: `60` хв (пт) + `450` хв (пн 10:30–18:00) = `510` хв, залишок `30` хв у вт → **вівторок 09:30**.

_(Поведінка зафіксована юніт-тестами в `apps/api/src/sla/business-time.test.ts`.)_

---

## 5. Конкурентність: `take-next`, версії, ідемпотентність, нумерація, bulk

- **«Взяти наступну» (`POST /tickets/take-next`, `QueueService.takeNext`):**
  У транзакції виконується вибірка 1 вільної заявки категорій користувача (`assignee_id IS NULL AND status IN ('new', 'open')`), відсортованої за `sla_sort_at ASC, priority_rank DESC, created_at ASC`, з блокуванням **`FOR UPDATE SKIP LOCKED`**. Паралельні виклики пропускають зайняті іншою транзакцією рядки та отримують різні заявки. Якщо вільних немає — `404 no_tickets_available`.
- **Оптимістичні версії (`PATCH /tickets/:id`, `TicketMutations.apply`):**
  Клієнт передає `version`. Сервер блокує рядок (`FOR UPDATE`), перевіряє версію і робить `UPDATE tickets SET ..., version = version + 1 WHERE id = $1 AND version = $2`. При розбіжності повертається `409 version_conflict` з `{ error: { code, message }, current: Ticket }`. Оновлення лише міток активності (`lastMessageAt`) при повідомленні без зміни полів не збільшує `version`.
- **Ідемпотентність відповідей (`POST /tickets/:id/messages`, `MessagesService.create`):**
  Клієнт генерує UUID `clientMessageId` (для чернетки зберігається в `localStorage` до успішного відправлення). У БД діє унікальний індекс `messages_author_client_id_uq (author_id, client_message_id)` — прив’язка до автора, а не до заявки, щоб повтор відповіді на `closed` заявку (який породжує нову дочірню заявку) теж розпізнавався. Повторний запит повертає `201` з оригінальними `{ message, ticket, newTicketId }` без дублювання повідомлення, зміни статусу, сповіщень чи SSE. Повторне використання того ж `clientMessageId` для іншої заявки дає `400 bad_request`.
- **Наскрізна нумерація без пропусків (`TicketsService.allocateNumber`):**
  Окремий однорядковий лічильник `ticket_counter (id = 1, value)` (ініціалізований `1000`, після сіду — на останній номер). У транзакції створення заявки виконується `UPDATE ticket_counter SET value = value + 1 WHERE id = 1 RETURNING value`. Блокування рядка серіалізує паралельні вставки, а відкат транзакції відкочує й інкремент — на відміну від `SEQUENCE`, немає ані дублів, ані пропусків.
- **Масові дії (`POST /tickets/bulk`, `QueueService.bulk`):**
  До `200` унікальних id за запит. Перед блокуванням id сортуються лексикографічно для уникнення дедлоків; кожна заявка обробляється у власному savepoint (`tx.transaction`), тож помилка (`not_found`, `forbidden`, `invalid_transition`, `invalid_assignee`, `ticket_closed`, `invalid_tags`) відкочує лише цю заявку і потрапляє у звіт `results`.

---

## 6. Фонові задачі

Реалізація: `apps/api/src/jobs/job-queue.ts`, `worker.ts`, `handlers.ts`. Таблиця `jobs` у PostgreSQL, без Redis.

- **Захоплення задач:** `UPDATE jobs ... WHERE id = (SELECT id FROM jobs WHERE (status = 'queued' AND run_at <= now) OR (status = 'running' AND locked_until < now) ORDER BY run_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)`. Lease — `5 хв` (`JOB_LEASE_MS`); при збої воркера після завершення lease задачу підхопить інший воркер. Повторні спроби до `5` разів із backoff `min(10 хв, 5с * 2^(attempts-1))`.
- **Планувальник:** періодично вставляє слот поточного інтервалу з унікальним `dedupe_key` (`type:ISO-slot`) через `ON CONFLICT (dedupe_key) DO NOTHING`. Кілька реплік `api` або перезапуск не планують слот двічі.
- **Типи задач (усі ідемпотентні та «наздоганяють» усе прострочене на `clock.now()`):**
  - `sla-scan` (кожні `60 с`): шукає відкриті заявки (`new`, `open`) з активним таймером; фіксує алерти в таблиці дедуплікації `sla_alerts` (`PK (ticket_id, alert, sla_kind, due_at)`), проставляє `sla_breached_first` / `sla_breached_resolution` та створює сповіщення `sla_warning` (за `30` хв до дедлайну — виконавцю) і `sla_breached` (виконавцю, або всім `lead`, якщо без виконавця).
  - `auto-close` (кожні `5 хв`): батчами по `500` з `FOR UPDATE SKIP LOCKED` переводить `resolved` → `closed`, якщо `resolved_at <= now - 3 дні` (актор `null` / система).
  - `attachment-cleanup` (кожні `15 хв`): батчами по `500` видаляє з БД та диска незв’язані вкладення (`message_id IS NULL`), створені понад `24 год` тому.
  - `housekeeping` (кожні `60 хв`): чистить прострочені `sessions`, `login_attempts` старші `24 год`, і завершені `jobs` (`done`/`failed`) старші `7 днів`.

---

## 7. Індекси, пошук і результати бенчмарку

### Індекси та пошук

Пагінація списку заявок — **keyset (курсорна)** по `(sort_column, t.id)`, що дає стабільний порядок під час змін і сталий час вибірки на будь-якій глибині. Для сортування за SLA використовується `NOT NULL` колонка `sla_sort_at = coalesce(next_due_at, '9999-12-31T00:00:00.000Z')`.

Повнотекстовий пошук (`toTsQuery`) використовує PostgreSQL FTS зі словником **`simple`** та префіксним збігом (`word:*` через `&`) по збережених `tsvector`-колонках:

- `tickets.search_vector` (`to_tsvector('simple', subject)`) + GIN `tickets_search_gin`;
- `messages.search_vector` (`to_tsvector('simple', body)`) + GIN `messages_search_gin` та частковий GIN `messages_public_search_gin (WHERE NOT internal)` для клієнтів;
- За запитом виду `HD-12345` або `12345` додатково шукається точний збіг за `tickets.number` (`tickets_number_uq`).

Основні індекси (`apps/api/drizzle/0000_init.sql`):

- Сортування і фільтри на `tickets`: `tickets_sla_sort_idx`, `tickets_created_idx`, `tickets_updated_idx`, `tickets_status_sla_idx`, `tickets_status_created_idx`, `tickets_assignee_status_sla_idx`, `tickets_category_status_sla_idx`, `tickets_category_created_idx`, `tickets_category_updated_idx`, `tickets_customer_updated_idx`, `tickets_customer_created_idx`, `tickets_tags_gin` (GIN), `tickets_parent_idx`.
- Часткові індекси: `tickets_queue_free_idx` (`category, sla_sort_at, priority_rank, created_at WHERE assignee_id IS NULL AND status IN ('new', 'open')`), `tickets_breached_idx`, `tickets_next_due_idx`, `tickets_resolved_at_idx`.
- Нотифікації / сесії / вкладення / черги: `notifications_user_unread_idx`, `attachments_orphan_idx`, `jobs_ready_idx`, `jobs_dedupe_uq`, `sla_pauses_open_uq`, `messages_author_client_id_uq`.

### Результати `bench` (`20 000` заявок, бюджет `< 200 мс`)

Замір виконано командою `pnpm --filter @helpdesk/api bench` (5 прогонів на сценарій, PostgreSQL 16):

| Сценарій                        | Рядків | `EXPLAIN` exec (мс) | Медіана wall (мс) |
| ------------------------------- | -----: | ------------------: | ----------------: |
| `lead: default (sla)`           |     50 |                0.36 |              4.26 |
| `lead: sort -created`           |     50 |                0.26 |              3.81 |
| `lead: status=new,open,pending` |     50 |                0.29 |              3.77 |
| `lead: tags=vip,refund`         |     50 |                2.55 |              5.86 |
| `lead: combined filters`        |     50 |                0.87 |              3.96 |
| `lead: search subject word`     |     50 |               14.56 |             15.69 |
| `lead: search message text`     |     50 |               27.48 |             29.94 |
| `lead: search number`           |      1 |                9.87 |             15.94 |
| `lead: deep page (sla, ~10k)`   |     50 |                0.56 |              5.89 |
| `agent: my open`                |     50 |                0.58 |              3.16 |
| `agent: search`                 |     50 |                9.11 |             18.73 |
| `customer: default (-updated)`  |     50 |                0.61 |              3.18 |
| `customer: search`              |     34 |                9.57 |             11.57 |

Найгірша медіана по всіх 34 сценаріях: **`29.94 мс`** (при бюджеті `200 мс`).

---

## 8. Матриця прав

Доступ до заявок перевіряється всередині SQL-запитів через `ticketScope(user)` (`apps/api/src/tickets/ticket-access.ts`), а внутрішні нотатки відсікаються через `messageVisibility(user)`:

- `customer`: `t.customer_id = user.id`; бачить лише публічні повідомлення (`not m.internal`), не отримує `events` (`[]`) та вкладень внутрішніх нотаток (`404`). Не може ставити пріоритет `urgent`.
- `agent`: `t.category = ANY(user.categories) OR t.assignee_id = user.id`. Може взяти вільну заявку на себе або зняти себе, але не перепризначити чужу заявку (`403`).
- `lead`: повний доступ до всіх заявок, перепризначення будь-якого співробітника, керування SLA, шаблонами відповідей і статистикою.

| Дія / Ендпоінт                                                         | `customer`                                                                  | `agent`                                | `lead`                                 |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------- |
| `POST /tickets` (створення, пріоритет `low..high`)                     | так                                                                         | ні (`403`)                             | ні (`403`)                             |
| `GET /tickets`, `GET /tickets/:id`, `POST /tickets/:id/read`           | лише свої (без нотаток/подій)                                               | свої категорії або призначені на нього | усі                                    |
| `PATCH /tickets/:id`, `POST /tickets/bulk`                             | ні (`403`)                                                                  | видимі; призначення лише `null ↔ self` | усі; призначення будь-кому з персоналу |
| `POST /tickets/take-next`                                              | ні (`403`)                                                                  | вільні у своїх категоріях              | вільні у будь-якій категорії           |
| `POST /tickets/:id/messages` (публічна відповідь)                      | свої                                                                        | видимі                                 | усі                                    |
| `POST /tickets/:id/messages` (`internal: true` / `followUp`)           | ні (`403`)                                                                  | видимі                                 | усі                                    |
| `POST /tickets/:id/resolve`, `POST /tickets/:id/rating`                | лише свої                                                                   | ні (`403`)                             | ні (`403`)                             |
| `POST /attachments`                                                    | так                                                                         | так                                    | так                                    |
| `GET /attachments/:id`                                                 | незв’язані — свої; зв’язані — видима заявка і `not internal` (`404` інакше) | видима заявка (або незв’язане своє)    | усі зв’язані (або незв’язане своє)     |
| `POST /tickets/:id/typing`, `GET /users/staff`, `/views`               | ні (`403`)                                                                  | так (видимі заявки / власні views)     | так                                    |
| `GET /canned-responses`, `GET /sla-policies`                           | ні (`403`)                                                                  | так (read-only)                        | так                                    |
| `POST/PUT/DELETE /canned-responses`, `PUT /sla-policies`, `GET /stats` | ні (`403`)                                                                  | ні (`403`)                             | так                                    |
| `GET /notifications`, `POST /notifications/read`, `GET /events`        | так (своя область видимості)                                                | так (своя область видимості)           | так                                    |

---

## 9. Формат помилок

Усі помилки (валідація Zod через `ZodPipe`, парсер JSON Express, доменні винятки `ApiError`, невідомі `4xx`/`5xx` у `ApiErrorFilter`) повертаються у єдиному форматі (`ApiErrorBodySchema`):

```json
{
  "error": {
    "code": "validation_error",
    "message": "Validation failed",
    "details": [
      {
        "path": "subject",
        "message": "String must contain at least 1 character(s)",
        "code": "too_small"
      }
    ]
  }
}
```

Додаткові поля верхнього рівня для спеціальних статусів:

- `409 version_conflict` містить `current` (актуальний DTO `Ticket`);
- `429 rate_limited` містить `retryAfterSeconds` і заголовок `Retry-After`.

Коди помилок (`ERROR_CODES` у `packages/shared/src/errors.ts`):
`validation_error`, `invalid_json`, `invalid_cursor`, `bad_request`, `unauthorized`, `invalid_credentials`, `forbidden`, `not_found`, `version_conflict`, `invalid_transition`, `invalid_assignee`, `ticket_closed`, `payload_too_large`, `unsupported_media_type`, `too_many_attachments`, `attachment_unavailable`, `no_tickets_available`, `rate_limited`, `internal_error`.

Типи вкладень (`POST /attachments`) перевіряються за вмістом файлу (magic bytes / UTF-8 перевірка тексту в `detect-type.ts`), а не за розширенням: дозволені `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `application/pdf`, `text/plain` до `10 МБ`, до `5` на повідомлення. Віддаються з `X-Content-Type-Options: nosniff` і `Content-Security-Policy: default-src 'none'; sandbox`.

---

## 10. Прийняті рішення та розширення API

- **Same-origin проксі у Next.js:** `apps/web/next.config.ts` проксує `/api/*` на `API_INTERNAL_URL`, що дозволяє використовувати `httpOnly`, `SameSite=Lax` cookie без CORS. Вимкнено стиснення (`compress: false`), щоб не буферизувати SSE, і збільшено `experimental.middlewareClientMaxBodySize: '25mb'`, щоб проксі не обрізав валідні 10 МБ завантаження на дефолтному ліміті 10 МБ.
- **SSE без Redis:** використано `PostgreSQL LISTEN/NOTIFY` на каналі `hd_events` із короткими сигналами (лише id). Кожен інстанс `api` будує персоналізований payload для кожного підключеного сокета через `ticketScope` і `messageVisibility`, тому внутрішня нотатка фізично не може потрапити до клієнта.
- **Атомарний rate-limit входу:** таблиця `login_attempts` під транзакційними advisory locks (`login:email:...` та `login:ip:...`) перевіряє та записує спробу _до_ перевірки Argon2-хешу (плюс dummy-hash для неіснуючих email проти timing attack).
- **FTS `simple`:** замість мовно-залежного стемінгу обрано словник `simple` із префіксами `:*`, оскільки заявки містять змішані українські та англійські тексти і точні номери.
- **Розширення API понад базову таблицю ТЗ:**
  - `POST /tickets/:id/resolve` та `POST /tickets/:id/rating` — кнопка «Проблема вирішена» й оцінка 1–5 від клієнта;
  - `POST /tickets/:id/read` — персистентна мітка прочитання (`ticket_reads`) для підсвітки «Нова відповідь»;
  - `POST /tickets/:id/typing` — індикатор «Зараз відповідає: …» для співробітників через SSE;
  - `GET /users/staff` — довідник персоналу для селектора виконавця;
  - `GET /views`, `POST /views`, `DELETE /views/:id` — вбудовані та власні збережені представлення;
  - `GET /sla-policies`, `PUT /sla-policies` — читання та налаштування термінів SLA;
  - `GET /health`, `GET /ready` — проби живості та готовності міграцій.

---

## Відомі обмеження

- **Відсутній `Last-Event-ID` replay для SSE:** `GET /events` не зберігає буфер подій; після перепідключення клієнт перечитує актуальні дані запитами.
- **Святкові дні:** SLA-календар враховує лише пн–пт 09:00–18:00 (`Europe/Kyiv`) без державних вихідних.
- **Пошук без морфології:** FTS зі словником `simple` шукає точні та префіксні збіги слів (без лематизації української/англійської).
- **Приймання #11 (автозакриття через 3 дні та відповідь у закриту заявку):** покрито інтеграційними тестами API (`apps/api/test/jobs.test.ts`, `messages.test.ts`) з підміною `Clock`, але не Playwright e2e.
- **Graceful `SIGTERM` на Windows:** тест `apps/api/test/shutdown.test.ts` пропускається на `win32` (де `SIGTERM` жорстко вбиває процес); виконується в Linux CI і перевірявся в Docker (`docker compose stop api` → код `0`).
- **Поточні прогалини UI / тестів (в роботі):** сторінки `/lead` і `/lead/settings`, юніт-тести `apps/web` (Vitest + Testing Library + MSW), axe e2e-перевірки.
