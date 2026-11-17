# Progress

Last updated at the end of the session. Repository state: `main`, everything committed passes
`pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (shared 25 tests, api 167
integration/unit tests on a real PostgreSQL 16; 1 skipped = SIGTERM test on Windows, web 0 unit
tests), and `pnpm test:e2e` (23 Playwright tests against the Docker Compose stack).

## Current stage

Completed: CI e2e job, `README.md`, `/lead` dashboard and `/lead/settings` UI, and `axe` e2e
accessibility checks (light & dark themes across all key pages).

## Done (committed and pushed)

| Area                                                                                                                                                          | State                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Monorepo, tooling, CI (lint+format+typecheck, tests on postgres:16, bench, e2e)                                                                               | done                     |
| `packages/shared`: Zod schemas, enums, transition matrix, SSE events, errors                                                                                  | done                     |
| api: schema + migrations, deterministic seed (20 000 tickets, ~10 s)                                                                                          | done                     |
| api: session auth, login rate limit (race-free), unified errors, Swagger `/docs`, `/health`, `/ready`                                                         | done                     |
| api: tickets (create/read/patch, numbering, history, 409 versions), messages (idempotency, transitions, closed -> new ticket), attachments (content sniffing) | done                     |
| api: SLA engine (business hours Europe/Kyiv, DST, pauses), job queue + scheduler + SLA scan / auto-close / cleanup                                            | done                     |
| api: list filters, FTS, cursor pagination, indexes, `bench` (worst median 29.94 ms < 200 ms)                                                                  | done                     |
| api: take-next, bulk, notifications, canned responses, saved views, SLA policies, stats                                                                       | done                     |
| api: SSE via LISTEN/NOTIFY + typing, graceful shutdown, fuzz tests                                                                                            | done                     |
| web: shell, next-intl uk/en, theme, login, customer portal, agent queue, ticket workspace, bell, `/lead`, `/lead/settings`                                    | done (no unit tests yet) |
| e2e (Playwright): acceptance 3–9, 12–15, shortcuts, `/lead` & `/lead/settings`, `axe` light & dark on key pages, hydration guard                              | done                     |
| Docker: multi-stage images, compose; verified clean `up`, 20 000 tickets, proxy login, `stop api` exit 0                                                      | done                     |
| Documentation: `README.md` verified against code and `bench`                                                                                                  | done                     |

## Remaining / Not done yet

1. **Web unit tests** (Vitest + Testing Library + MSW): forms and a11y attributes, drafts, SSE
   merge (`mergeTicketIntoPages`, `applyServerEvent`), hotkeys, composer note/reply switch, 409
   handling, `uk`/`en` key parity test, date/plural formatting (`apps/web/vitest.config.ts` currently
   runs with `passWithNoTests: true`).
2. **i18n e2e**: dedicated Playwright test for `uk`/`en` relative time and pluralization rendering.
3. **Accessibility polish**: focus management after sending a message in the ticket workspace.
4. **Fresh-clone verification**: `git clean -xfd` full clean-clone run of acceptance table 1–18.

## Known problems / limitations

- Editor diagnostics about `@helpdesk/shared` or `any` in `apps/web` appear while
  `packages/shared/dist` is being rebuilt; `pnpm typecheck` is clean.
- Acceptance 11 (auto-close after 3 days, reply creates a new ticket) is covered by api integration
  tests with a fake clock, not by e2e.
- `Last-Event-ID` replay is not implemented; the client refetches after reconnect.
- Public holidays are not part of the SLA calendar; FTS uses the `simple` configuration.
- The SIGTERM process test is skipped on Windows (hard kill); it runs on Linux/CI, and was verified
  manually in Docker (`docker compose stop api` -> exit code 0).
- `postgres:16-alpine` produced `exec format error` on the dev machine, so `postgres:16`
  (Debian) is used everywhere.
- Windows: `next build` needs `NEXT_OUTPUT=standalone` only in Docker (symlinks); local builds do
  not use standalone output.
