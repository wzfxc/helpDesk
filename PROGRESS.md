# Progress

Last updated after final polish. Repository state: `main`, everything committed passes
`pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (shared 25 tests, api 170
integration/unit tests on a real PostgreSQL 16; 1 skipped = SIGTERM test on Windows, web 12
unit/component tests), and `pnpm test:e2e` (25 Playwright tests against the Docker Compose stack).

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
| api: list filters, FTS, cursor pagination, indexes, `bench` (worst median 29.94 ms < 200 ms)                                                                  | done  |
| api: take-next, bulk, notifications, canned responses, saved views, SLA policies, stats                                                                       | done  |
| api: SSE via LISTEN/NOTIFY with `Last-Event-ID` replay + typing, graceful shutdown, fuzz tests                                                                | done  |
| web: shell, next-intl uk/en, theme, login, customer portal, agent queue, ticket workspace, focus management, bell, `/lead`, `/lead/settings` + unit tests     | done  |
| e2e (Playwright): acceptance 3–9, 11–15, shortcuts, `/lead` & `/lead/settings`, `i18n`, `axe` light & dark on key pages, hydration guard                      | done  |
| Docker: multi-stage images, compose; verified clean `up`, 20 000 tickets, proxy login, `stop api` exit 0                                                      | done  |
| Documentation: `README.md` verified against code and `bench`                                                                                                  | done  |

## Remaining / Not done yet

None.

## Known problems / limitations

All previously tracked functional and test limitations have been resolved. Platform/design notes:

- FTS deliberately uses PostgreSQL `simple` dictionary for bilingual Ukrainian/English prefix search.
- The SIGTERM process test is skipped on Windows (hard kill); it runs on Linux/CI and was verified
  in Docker (`docker compose stop api` -> exit code 0).
- `postgres:16-alpine` produced `exec format error` on the dev machine, so `postgres:16`
  (Debian) is used everywhere.
- Windows: `next build` needs `NEXT_OUTPUT=standalone` only in Docker (symlinks); local builds do
  not use standalone output.
