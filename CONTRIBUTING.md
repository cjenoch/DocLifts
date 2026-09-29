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

`pnpm test:e2e` runs a browser end-to-end pass against a production build served locally (Content-Security-Policy violations, page rendering). It needs `pnpm build` first, a Chromium that Playwright can find, and the same test database as the server tests. Locally it skips itself when either the build or the browser is missing, printing one `[e2e] skipped` line, and the run still reports green. A green local run therefore does not prove CSP coverage unless the e2e tests actually ran; set `CI=1` to turn a missing prerequisite into a failure. In CI it is always required.

For a disposable hands-on preview, follow [the demo guide](docs/demo.md).

If the default browser-test port is reserved on Windows, set `PW_TEST_PORT` to an available port, for example `4193`.
