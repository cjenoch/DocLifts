# Contributing to DocLifts

DocLifts is licensed under Apache-2.0. Contributions should include appropriate tests and preserve workout history, machine identity, and the separation between suggestions and recorded performance.

Use fictional fixtures only. Do not commit database dumps, `.env` files, real workout logs, credentials, or private host configuration. Report suspected vulnerabilities privately through the repository's security reporting feature if available; avoid posting secrets in public issues.

Read `CLAUDE.md` for architectural rules. Run `pnpm check`, `pnpm lint` and `pnpm test`; server integration tests require a separate PostgreSQL test database. Set `TEST_DATABASE_URL` to that test database, never to a personal installation. The built-in default (`postgresql://localhost/doclifts_test`) carries no user, so it only works if a Postgres role named after your OS user exists; set the variable rather than relying on it. Browser tests can use `PW_EXECUTABLE_PATH` to select an installed Chrome executable.

`pnpm lint` (Prettier) is a blocking CI check. Run `pnpm format` before committing.

`pnpm build` needs `DATABASE_URL` set, even though the build never connects: the DB module throws at import time if it is missing. Any syntactically valid URL works for a build-only run (the Dockerfile uses a placeholder for the same reason).

`pnpm test:e2e` runs a browser end-to-end pass against a production build served locally (Content-Security-Policy violations, page rendering). It needs `pnpm build` first, a Chromium that Playwright can find, and the same test database as the server tests. Locally it skips itself when either the build or the browser is missing; in CI it is required.

For a disposable hands-on preview, follow [the demo guide](docs/demo.md).

If the default browser-test port is reserved on Windows, set `PW_TEST_PORT` to an available port, for example `4193`.
