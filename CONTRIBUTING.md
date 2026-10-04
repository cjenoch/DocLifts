# Contributing to DocLifts

DocLifts is licensed under the Functional Source License, Version 1.1, ALv2 Future License (FSL-1.1-ALv2); see [LICENSE](LICENSE). Contributions should include appropriate tests and preserve workout history, machine identity, and the separation between suggestions and recorded performance.

## Contribution license terms

By submitting a contribution (pull request, patch, or commit) you certify the [Developer Certificate of Origin 1.1](https://developercertificate.org/) for that contribution and you agree that:

1. your contribution is licensed to Enoch AI LLC and to all recipients under the same FSL-1.1-ALv2 terms as the rest of the repository, including the grant of a future Apache-2.0 license; and
2. Enoch AI LLC may relicense the repository, including your contribution, under other terms in a future release. This is what allows the project to be offered under a different license later without contacting every past contributor.

Sign off each commit with `git commit -s` to record the DCO certification. Contributions without a sign-off will be asked to add one before merge.

## Commit identity

Commits made by automated coding agents on behalf of a maintainer use the maintainer's name and email as the author, and add a `Co-authored-by:` trailer naming the agent (for example `Co-authored-by: Hermes <hermes@agents.local>`). `.mailmap` normalizes historical agent identities; keep it current when an agent's identity changes.

Use fictional fixtures only. Do not commit database dumps, `.env` files, real workout logs, credentials, or private host configuration. Report suspected vulnerabilities privately through the repository's security reporting feature if available; avoid posting secrets in public issues.

Read `CLAUDE.md` for architectural rules. Run `pnpm check`, `pnpm lint` and `pnpm test`; server integration tests require a separate PostgreSQL test database. Set `TEST_DATABASE_URL` to that test database, never to a personal installation. The built-in default (`postgresql://localhost/doclifts_test`) carries no user, so it only works if a Postgres role named after your OS user exists; set the variable rather than relying on it. Browser tests can use `PW_EXECUTABLE_PATH` to select an installed Chrome executable.

`pnpm lint` (Prettier) is a blocking CI check. Run `pnpm format` before committing.

`pnpm build` needs `DATABASE_URL` set, even though the build never connects: the DB module throws at import time if it is missing. Any syntactically valid URL works for a build-only run (the Dockerfile uses a placeholder for the same reason).

`pnpm test:e2e` runs a browser end-to-end pass against a production build served locally (Content-Security-Policy violations, page rendering). It needs `pnpm build` first, a Chromium that Playwright can find, and the same test database as the server tests. Locally it skips itself when either the build or the browser is missing, printing one `[e2e] skipped` line, and the run still reports green. A green local run therefore does not prove CSP coverage unless the e2e tests actually ran; set `CI=1` to turn a missing prerequisite into a failure. It is required for application changes and manual CI runs; the documentation-only exception is described below.

## Development runtime

Run `pnpm install --frozen-lockfile` before working. The devEngines.runtime pin
in package.json installs Node 24.21.0 for project scripts and pnpm exec; the
lockfile records the runtime download checksums. Check with `pnpm exec node --version`.
A bare node command still uses your shell's runtime. Run standalone scripts with
`pnpm exec node`, and do not change a shared host's global Node to work on DocLifts.

When updating Node, change devEngines.runtime, .node-version and both Dockerfile
base images together, regenerate the lockfile with pnpm install, then run the
full gate. CI checks the actual project and production-container Node versions
against .node-version. Development/CI use glibc on Linux while production uses
Alpine musl; the Docker build and native-image check still cover that difference.

## Documentation-only CI

For a change containing only regular Markdown files at the repository root or
under docs/, run `pnpm lint` locally. CI runs the same formatting gate without
starting Postgres, Playwright, application builds or Docker builds.

The comparison covers the complete pull request or push, not just the last
commit. Any code, source Markdown, configuration or workflow change runs the
full gate. Symlinks, code renamed to Markdown, an empty/unknown comparison and
manual workflow dispatch also use the full gate.

The final `test` check must pass on either path; skipped or failed required jobs
cannot count as a successful gate. The production dependency audit runs with the
full path and on its independent weekly schedule.

## Focused checks while developing

Use a narrow loop while editing, then the full release gate once the change is ready:

| Change                                    | Command                                                     |
| ----------------------------------------- | ----------------------------------------------------------- |
| Server function or route                  | `pnpm test:server quick-workouts` (replace the file filter) |
| Svelte component                          | `pnpm test:client SetRow`                                   |
| Git changes and their detected dependants | `pnpm test:changed`                                         |
| Workout browser flows                     | `pnpm build && pnpm test:e2e:workout`                       |
| One served page suite                     | `pnpm build && pnpm test:e2e e2e/csp.e2e.ts`                |

The changed-file command uses Vitest's dependency analysis. It is a development convenience, not evidence that unrelated integration paths still work. None of these filters replaces the full gate in `CLAUDE.md`: lint, check, Drizzle snapshot check with the test DB URL, all server tests, all component tests, build, and all e2e tests with `CI=1`, followed by branch CI. `pnpm test` retains its existing all-project behavior.

Browser suites share prerequisite checks, authenticated page creation and CSP auditing in `e2e/browser.ts`. Each page has a fresh browser context; each suite still owns its server, database setup and teardown. The route crawl checks the initial phone render and the resized desktop view in one visit per route. Keep all route patterns, ownership checks, real-browser auth regressions, and the CSP canary when consolidating tests.

Tests must justify their maintenance cost with a distinct failure they detect. Prefer extending an existing scenario when it already crosses the relevant boundary. Do not add another test just to assert a label or mirror implementation details. Consolidation should remove setup and repeated navigation, not hide lost coverage behind a smaller count.

Production smoke checks must use an automation-only account. Human Alpha testers' accounts and the owner's account are not fixtures; never seed, clear, or run destructive controls against them. Check first-use behavior before creating fixtures in an explicitly fresh automation account.

The hosted Alpha is at [doclifts.runthe.ai](https://doclifts.runthe.ai); access is currently operator-managed. For development, use the isolated local database setup in [README.md](README.md).

If the default browser-test port is reserved on Windows, set `PW_TEST_PORT` to an available port, for example `4193`.
