# Contributing to DocLifts

DocLifts is licensed under Apache-2.0. Contributions should include appropriate tests and preserve workout history, machine identity, and the separation between suggestions and recorded performance.

Use fictional fixtures only. Do not commit database dumps, `.env` files, real workout logs, credentials, or private host configuration. Report suspected vulnerabilities privately through the repository's security reporting feature if available; avoid posting secrets in public issues.

Read `CLAUDE.md` for architectural rules. Run `pnpm check` and `pnpm test`; server integration tests require a separate PostgreSQL test database. Set `TEST_DATABASE_URL` to that test database, never to a personal installation. Browser tests can use `PW_EXECUTABLE_PATH` to select an installed Chrome executable.

For a disposable hands-on preview, follow [the demo guide](docs/demo.md).

If the default browser-test port is reserved on Windows, set `PW_TEST_PORT` to an available port, for example `4193`.
