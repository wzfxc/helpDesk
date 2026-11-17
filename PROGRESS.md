# Progress

Last updated at the end of the session. Repository state: `main`, everything committed passes
`pnpm lint`, `pnpm typecheck` and `pnpm test` (shared 25 tests, api 167 integration/unit tests on
a real PostgreSQL 16; 1 skipped = SIGTERM test on Windows).

## Current stage

Priority from the user: acceptance table first (web for scenarios 3–8, 11, 12, 13, 15, Docker
Compose, e2e for them), then README, then the remaining UI. **The README is not written yet.**

## Done (committed and pushed)

| Area                                                                                                                                                          | State                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Monorepo, tooling, CI (lint+format+typecheck, tests on postgres:16, bench)                                                                                    | done                     |
| `packages/shared`: Zod schemas, enums, transition matrix, SSE events, errors                                                                                  | done                     |
| api: schema + migrations, deterministic seed (20 000 tickets, ~10 s)                                                                                          | done                     |
| api: session auth, login rate limit (race-free), unified errors, Swagger `/docs`, `/health`, `/ready`                                                         | done                     |
| api: tickets (create/read/patch, numbering, history, 409 versions), messages (idempotency, transitions, closed -> new ticket), attachments (content sniffing) | done                     |
| api: SLA engine (business hours Europe/Kyiv, DST, pauses), job queue + scheduler + SLA scan / auto-close / cleanup                                            | done                     |
| api: list filters, FTS, cursor pagination, indexes, `bench` (worst median 49 ms < 200 ms)                                                                     | done                     |
| api: take-next, bulk, notifications, canned responses, saved views, SLA policies, stats                                                                       | done                     |
| api: SSE via LISTEN/NOTIFY + typing, graceful shutdown, fuzz tests                                                                                            | done                     |
| web: shell, next-intl uk/en, theme, login, customer portal, agent queue, ticket workspace, bell                                                               | done (no unit tests yet) |
| Docker: multi-stage images, compose; verified clean `up`, 20 000 tickets, proxy login, `stop api` exit 0                                                      | done                     |

## In progress / uncommitted-quality

- **e2e (Playwright)** in `e2e/tests/*.spec.ts` covers acceptance 3, 4, 5, 6, 7, 8, 9, 12, 13, 14, 15
  and keyboard shortcuts. Last full run against the compose stack: 13 passed, 3 failed. The failures
  were then fixed but **not re-run**: (a) Next's rewrite proxy truncated bodies at 10 MB, so the
  11 MB upload returned 500 instead of 413 -> `experimental.middlewareClientMaxBodySize: '25mb'`
  in `apps/web/next.config.ts`; (b) the note-search assertion matched the ticket subject (test
  bug, fixed); (c) the bulk test generated duplicate ids (test bug, fixed). Re-run with
  `docker compose up -d --build --wait` then `pnpm test:e2e`.
- The e2e job is **not in the CI workflow yet**.

## Next steps (in order)

1. Rebuild the stack, run e2e, fix what fails; add the e2e job to `.github/workflows/ci.yml`
   (compose up --wait, Playwright chromium with browser cache, upload report on failure).
2. Write `README.md` (quick start + accounts table, transition table, SLA examples, take-next /
   versions / idempotency / numbering, jobs, indexes + bench results, permission matrix, error
   format, API extensions, decisions, limitations). Accounts: `lead@helpdesk.local` /
   `lead123`, `agent1..6@helpdesk.local` / `agent123` (agent1 billing+account, agent2
   billing+delivery, agent3 delivery+other, agent4 technical+account, agent5 technical+other,
   agent6 technical+billing), `customer1..200@example.com` / `customer123`.
3. Remaining UI: lead dashboard (`/lead`) and settings (`/lead/settings`: SLA policies, canned
   responses) — the header already links to them, the pages do not exist yet; API is ready.
4. Web unit tests (Vitest + Testing Library + MSW): forms and a11y attributes, drafts, SSE merge
   (`mergeTicketIntoPages`, `applyServerEvent`), hotkeys, composer note/reply switch, 409 handling,
   uk/en key parity test, date/plural formatting.
5. e2e: axe in light and dark themes on key pages, uk/en relative time and plurals, hydration
   guard is already active in every test.
6. Accessibility polish (focus management after sending, contrast check in dark theme).
7. Final pass: acceptance table 1–18, README vs code, `git clean -xfd` fresh-clone run.

## Known problems / limitations

- Editor diagnostics about `@helpdesk/shared` or `any` in `apps/web` appear while
  `packages/shared/dist` is being rebuilt; `pnpm typecheck` is clean.
- Acceptance 11 (auto-close after 3 days, reply creates a new ticket) is covered by api integration
  tests with a fake clock, not by e2e.
- Not implemented yet: lead pages, web unit tests, axe/i18n e2e, README, e2e in CI.
- `Last-Event-ID` replay is not implemented; the client refetches after reconnect.
- Public holidays are not part of the SLA calendar; FTS uses the `simple` configuration.
- The SIGTERM process test is skipped on Windows (hard kill); it runs on Linux/CI, and was verified
  manually in Docker (`docker compose stop api` -> exit code 0).
- `postgres:16-alpine` produced `exec format error` on the dev machine, so `postgres:16`
  (Debian) is used everywhere.
- Windows: `next build` needs `NEXT_OUTPUT=standalone` only in Docker (symlinks); local builds do
  not use standalone output.
