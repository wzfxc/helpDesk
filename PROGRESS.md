# Progress

Last updated after the reviewer round (limits audit, queue focus, NUL bytes, /stats, closed UI, ports). Repository state: `main`, everything committed passes
`pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (shared 25 tests, api 206
integration/unit tests on a real PostgreSQL 16; 1 skipped = SIGTERM test on Windows, web 19
unit/component tests), and `pnpm test:e2e` (33 Playwright tests against a clean Docker Compose stack).

## Current stage

Completed: full test coverage and elimination of all previously tracked functional/testing
limitations — `apps/web` unit/component tests (Vitest + Testing Library + MSW), E2E coverage for
acceptance #11 (`resolved` -> `closed` + child ticket) and `uk`/`en` i18n/pluralization/focus,
`Last-Event-ID` SSE replay, and configurable `SLA_HOLIDAYS`.

## Done (committed and pushed)

| Area                                                                                                                                                          | State |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Monorepo, tooling, CI (lint+format+typecheck, tests on postgres:16, bench, e2e)                                                                               | done  |
| `packages/shared`: Zod schemas, enums, transition matrix, SSE events, errors                                                                                  | done  |
| api: schema + migrations, deterministic seed (20 000 tickets, ~10 s)                                                                                          | done  |
| api: session auth, login rate limit (race-free), unified errors, Swagger `/docs`, `/health`, `/ready`                                                         | done  |
| api: tickets (create/read/patch, numbering, history, 409 versions), messages (idempotency, transitions, closed -> new ticket), attachments (content sniffing) | done  |
| api: SLA engine (business hours Europe/Kyiv, DST, pauses, configurable `SLA_HOLIDAYS`), job queue + scheduler + SLA scan / auto-close / cleanup               | done  |
| api: list filters, FTS, cursor pagination, indexes, `bench` incl. `GET /stats` week..year (worst median ~178 ms < 200 ms)                                     | done  |
| api: take-next, bulk, notifications, canned responses, saved views, SLA policies, stats                                                                       | done  |
| api: SSE via LISTEN/NOTIFY with `Last-Event-ID` replay + typing, graceful shutdown, fuzz tests                                                                | done  |
| web: shell, next-intl uk/en, theme, login, customer portal, agent queue, ticket workspace, focus management, bell, `/lead`, `/lead/settings` + unit tests     | done  |
| e2e (Playwright): acceptance 3–9, 11–15, shortcuts, `/lead` & `/lead/settings`, `i18n`, `axe` light & dark on key pages, hydration guard                      | done  |
| Docker: multi-stage images, compose; verified clean `up`, 20 000 tickets, proxy login, `stop api` exit 0                                                      | done  |
| Documentation: `README.md` verified against code and `bench`                                                                                                  | done  |

## Reviewer round (this iteration)

| Item                             | Fix                                                                                                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Enter opened the wrong ticket | Queue cursor is the ticket id (`lib/queue-focus.ts`), neighbour fallback when the ticket leaves; unit + e2e (sort `sla` and `-created`)                                 |
| 2. 500 on `\u0000`               | `safeString()` on all DTO strings, PG class 22 -> 400 in the error filter, fuzz test injects NUL into every string field                                                |
| 3. `/stats` slow (1.3-1.5 s)     | prefix-sum business-minute counter, packed JSON arrays, partial indexes (migration `0002`); bench scenarios week/quarter/half year/year: 120-180 ms                     |
| 4. Closed ticket (staff)         | translated notice (`composer.closedStaff`), read-only fields with `ticket.closedReadonly` + `aria-describedby`, unit tests                                              |
| 5. Exposed ports                 | postgres and api bound to `127.0.0.1`, default-password warning in README and `.env.example`                                                                            |
| 6. README                        | limits table, honest "Відомі обмеження", new bench scenarios, verified against code                                                                                     |
| 0. Limits audit                  | table below; found and fixed: 500 on 30 MiB upload via Next, no unattached-upload quota, shared per-IP login lock-out, no throttles, no SSE cap, no `statement_timeout` |

Problems found during the round (and fixed): a 30 MiB upload through the Next proxy returned `500`
(`socket hang up`); the per-IP login cap let one user's failures block everyone behind the proxy; an
`urlencoded` parser added for size capping was removed after review (CSRF-able content type); the
quota check was made atomic (advisory lock) after review; my own e2e test used an invalid priority
and broke CI for several commits (fixed in `7550170`; CI green afterwards).

### Limits audit: limit -> where set -> value -> test

All values live in `packages/shared/src/limits.ts` unless noted; full descriptions in README
section 9 ("Ліміти").

| Limit                        | Where set                                          | Value                                                                                                                                                       | Test                                  |
| ---------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Attachment size              | `attachmentMaxBytes`, multer `fileSize`, web, Next | 10 MiB (`10*1024*1024`); +1 byte -> 413                                                                                                                     | `limits.test.ts`, `limits.spec.ts`    |
| Attachments per message      | `AttachmentIdsSchema`                              | 5 (6th -> 400); foreign/bound -> 422                                                                                                                        | `limits.test.ts`                      |
| multipart parts/fields/sizes | multer `limits`                                    | files 1, parts 6, fields 5, field 1 KiB, name 100 B, headers 50 -> 400                                                                                      | `limits.test.ts`                      |
| Unattached uploads per user  | `AttachmentsService.assertQuota`                   | 20 files / 100 MiB -> 422 `attachment_quota_exceeded`                                                                                                       | `limits.test.ts`                      |
| JSON body                    | `app.setup.ts`                                     | 256 KB -> 413; no urlencoded parser                                                                                                                         | `limits.test.ts`, `limits.spec.ts`    |
| Next proxy body              | `apps/web/src/middleware.ts`, `next.config.ts`     | 10 MiB+64 KiB uploads, 256 KB rest -> 413; 25 MB safety net                                                                                                 | `limits.spec.ts`                      |
| Text lengths                 | Zod schemas                                        | subject 200, body 20 000, template 120/10 000, view 80/2000, comment 2000, tag 40x20, q 200, cursor 1000, email 254, password 200, version <= 2^31-1 -> 400 | `limits.test.ts`, `schemas.test.ts`   |
| NUL byte                     | `safeString()`, PG 22xxx -> 400                    | rejected everywhere                                                                                                                                         | `fuzz.test.ts`                        |
| Pagination                   | `TicketListQuerySchema`                            | limit 1..100 (default 50) else 400                                                                                                                          | `limits.test.ts`, `list.test.ts`      |
| Bulk                         | `BulkRequestSchema`                                | 1..200 unique ids, duplicates -> 400, tag limits as PATCH                                                                                                   | `limits.test.ts`, `queue.test.ts`     |
| Login                        | `AuthService.assertNotLimited`                     | 5/15 min per (email, IP); 20 per account; 200 per IP; `Retry-After`                                                                                         | `ratelimit.test.ts`, `limits.spec.ts` |
| Throttles                    | `RateLimiter`, `LIMITS.rate`                       | tickets 60/10 min, messages 60/min, uploads 60/10 min, typing 1/s                                                                                           | `ratelimit.test.ts`                   |
| SSE                          | `EventsService.subscribe`                          | 8 streams per user -> 429; heartbeat 20 s                                                                                                                   | `events.test.ts`                      |
| DB                           | `createPool`, `docker-compose.yml`                 | statement 10 s, idle-in-tx 15 s, connect 10 s, pool 20 < max_conn 100 -> 503                                                                                | `db-limits.test.ts`                   |
| `/stats` speed               | `MiscService.stats`                                | < 200 ms on 20 000 tickets                                                                                                                                  | `bench` (CI)                          |

## Remaining / Not done yet

See README "Відомі обмеження" for the honest list (in-memory throttles per instance, thin `/stats`
headroom of ~20-80 ms, memory-buffered uploads, orphan files after a crash, chunked >25 MB bodies
through the proxy, no CAPTCHA).

## Known problems / limitations

- FTS deliberately uses PostgreSQL `simple` dictionary for bilingual Ukrainian/English prefix search.
- The SIGTERM process test is skipped on Windows (hard kill); it runs on Linux/CI and was verified
  in Docker (`docker compose stop api` -> exit code 0).
- `postgres:16-alpine` produced `exec format error` on the dev machine, so `postgres:16`
  (Debian) is used everywhere.
- Windows: `next build` needs `NEXT_OUTPUT=standalone` only in Docker (symlinks); local builds do
  not use standalone output.
- A host Postgres on `127.0.0.1:5432` makes `docker compose up` fail to bind; set `POSTGRES_PORT`.
