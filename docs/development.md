# Local development

Run commands from the repository root. Use Docker with Linux containers for
PostgreSQL 16 and the pnpm version in `package.json`. Installation downloads the
project's Node 24.22.1; `pnpm exec node --version` should report that version.
There is no need to replace another application's global Node runtime.

## Database and environment

Use the isolated database command in the [README](../README.md#local-development).
Its PowerShell equivalent is:

```powershell
docker run -d --name doclifts-dev-db `
  -e POSTGRES_USER=doclifts -e POSTGRES_PASSWORD=dev-only -e POSTGRES_DB=doclifts `
  -p 127.0.0.1:55432:5432 `
  -v doclifts_dev_pgdata:/var/lib/postgresql/data postgres:16
Copy-Item .env.example .env
```

This container is for development only. Keep the app and test databases separate.
Set these values in the copied `.env`:

```dotenv
DATABASE_URL=postgresql://doclifts:dev-only@127.0.0.1:55432/doclifts
TEST_DATABASE_URL=postgresql://doclifts:dev-only@127.0.0.1:55432/doclifts_test
PUBLIC_ORIGIN=http://localhost:5173
```

Generate a local `BETTER_AUTH_SECRET` with `openssl rand -base64 32` and put it
in `.env`. Keep that file untracked. Leave production proxy, storage and provider
settings unset until you need those integrations; manual logging needs no AI key.

```sh
pnpm install --frozen-lockfile
pnpm exec node --version
docker exec doclifts-dev-db pg_isready -U doclifts -d doclifts
pnpm db:migrate
```

Run the migration only after PostgreSQL reports it is accepting connections.
Drizzle loads `.env` through `dotenv/config`. The standalone account scripts do
not: they read `process.env`, so use `--env-file=.env` as shown below. Already
exported environment variables take precedence over the file; use a clean local
shell if you previously exported deployment settings.

## Create the first account

Bootstrap after applying the full migration chain. The command claims the
migration's sentinel owner or creates the first account on an empty database.
It is not the command for adding a second user. There is no demo seed step.

In Bash, enter the password at a hidden prompt and pipe it into the CLI:

```bash
read -r -s -p 'Local account password: ' doclifts_password
printf '\n'
printf '%s' "$doclifts_password" | pnpm exec node --env-file=.env --import tsx scripts/user-bootstrap.ts --email lifter@example.invalid --password-stdin
unset doclifts_password
```

In PowerShell:

```powershell
$docliftsCredential = Get-Credential -UserName 'lifter@example.invalid' -Message 'Create your local DocLifts account'
try {
  $docliftsCredential.GetNetworkCredential().Password | pnpm exec node --env-file=.env --import tsx scripts/user-bootstrap.ts --email lifter@example.invalid --password-stdin
} finally {
  Remove-Variable docliftsCredential
}
```

The password must satisfy the configured policy in `.env.example`. It is supplied
through stdin, not a command-line argument. `--password-stdin` requires a pipe;
running that flag alone does not prompt for a password.

For additional local accounts, substitute `scripts/user-create.ts`, the desired
email, and add the required `--name 'Local Lifter'` argument. For a local password reset, use `scripts/user-set-password.ts` with the same
environment loading and stdin pattern. Production uses `scripts/user-prod.sh` on
the VPS instead; see the [release runbook](release-0.2.0.md).

## Run the app

```sh
pnpm exec node --env-file=.env node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --strictPort
```

Open `http://localhost:5173` and sign in with the account you created. The browser
origin must match `PUBLIC_ORIGIN`; `localhost` and `127.0.0.1` are different
origins. `--strictPort` prevents Vite from silently moving to another port.

The explicit Node invocation loads the auth secret and origin into `process.env`
before the server imports them. Bare `pnpm dev` relies on those variables already
being exported; Vite's `.env` handling alone is not enough for those reads.

Create a starter program or a quick workout and log a manual set. Configure photo
storage, screening and identification separately using [photos](photos.md),
[photo safety](photo-safety.md) and `.env.example`.

## Validation

For changes limited to root/docs Markdown, the local gate is `pnpm lint`.
Format the edited paths first with `pnpm exec prettier --write <paths>`.
For application changes, run the full gate sequentially:

```sh
pnpm exec playwright install chromium
pnpm lint
pnpm check
pnpm exec node --env-file=.env node_modules/drizzle-kit/bin.cjs check
pnpm test:server
pnpm test:client
pnpm build
CI=1 pnpm test:e2e
```

In PowerShell, replace the last command with:

```powershell
$docliftsPreviousCi = $env:CI
try {
  $env:CI = '1'
  pnpm test:e2e
} finally {
  $env:CI = $docliftsPreviousCi
}
```

Vitest reads `TEST_DATABASE_URL` and redirects the app DB connection to it before
loading test modules. The name must end in `_test`. The helper connects to the
`postgres` database on the same server to create the test database if needed,
then applies migrations and resets fixture data. The development container's role
has these permissions. Never run server and e2e suites concurrently against the
same test database.

Browser suites need Chromium and the e2e suites need a production build.
`PW_EXECUTABLE_PATH` can select an existing Chromium executable. `CI=1` makes
missing e2e prerequisites fail; a local skipped suite is not browser validation.
The complete PR must also pass branch CI before merge. See
[Contributing](../CONTRIBUTING.md) for focused checks and the documentation exception.

## Troubleshooting

| Symptom                                                   | Check                                                                                                      |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Account CLI reports a missing database URL or auth secret | Load `.env` explicitly and check that its required values are filled in.                                   |
| `--password-stdin` refuses to run                         | Supply a pipe using the account examples above.                                                            |
| Database authentication fails using your OS username      | Set `TEST_DATABASE_URL` with the local role and port; the fallback URL has no credentials.                 |
| Test database creation is refused                         | The test role needs access to `postgres` and `CREATEDB`, or an already-created test database.              |
| Sign-in reports an origin error                           | Match the browser URL, port and `PUBLIC_ORIGIN`; restart after changing the environment.                   |
| Browser tests skip or cannot launch                       | Install Chromium, build before e2e, and run with `CI=1`.                                                   |
| The named development container already exists            | Use `docker start doclifts-dev-db` and check readiness; do not recreate its volume to fix a startup error. |
