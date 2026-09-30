# DocLifts

[![CI](https://github.com/cjenoch/DocLifts/actions/workflows/ci.yml/badge.svg)](https://github.com/cjenoch/DocLifts/actions/workflows/ci.yml)

A single-user weightlifting log for training across gyms: record what you lifted, get suggestions for the next set, and keep your training history together. Self-hosted on a private VPS with Docker Compose and Tailscale access.

This is the personal project behind [DocLifts — Training, AI-Assisted Development, and QA](https://enoch.ai/case-studies/doclifts/). AI tools support development and review; the app's training logic does not depend on an LLM.

## Try the demo

```sh
docker compose -f compose.demo.yml up --build -d
```

Open **http://localhost:4179** after initialization. This separate, temporary stack contains fictional workouts and equipment. It needs no `.env` or access to the author's VPS, and never mounts a production database. [Demo setup, reset, and troubleshooting](docs/demo.md).

DocLifts is source-available under the **Functional Source License, Version 1.1, ALv2 Future License** (FSL-1.1-ALv2). Internal use, self-hosting, non-commercial use, and professional services are permitted; offering it as a competing commercial product or service is not. Each version becomes Apache-2.0 two years after release. Versions 0.1.0 and earlier remain Apache-2.0. See [LICENSE](LICENSE), [NOTICE](NOTICE), and [contribution guidance](CONTRIBUTING.md).

## Features and engineering

- Machine identity, equipment-aware plate snapping, and session quick-add.
- A phone-friendly workout screen with searchable exercise selection, inline gym/equipment setup, and working/warmup/backoff sets added directly to an exercise. The last empty set can be removed without renumbering existing sets.
- Explicit saving/error states and unfinished set drafts retained through Pause/Resume and reload in the same browser tab. Drafts are not saved workout records or synced between devices; use Save to persist them. Finishing a workout prompts you to save unfinished entries first.
- MAIN backoff suggestions derived from the top set actually performed.
- A drag-and-drop program editor with transactional draft handling and a Traveling Push/Pull/Legs preset.
- Workout history editing, soft deletion, and restoration.
- A searchable imported-history archive at `/imported-history`. Original notes, recalled estimates, and uncertain dates are preserved. Archive records do not feed progression or operational workout-report totals. The September 2026 import added 107 records without changing the existing 31 sessions and 467 sets. Personal import payloads are not distributed in this repository.
- Session-start concurrency protection in the interface, server, and database, backed by an integration test.
- One CI workflow, run inside the Playwright container image: Prettier, svelte-check, server tests against PostgreSQL, component tests in Chromium, a production build, and an end-to-end Content-Security-Policy pass against that build. Consult the workflow and its results for current coverage rather than a fixed test-count claim.

## Current deployment

The production application and PostgreSQL run together on an Ubuntu 24.04 VPS on **Akamai Cloud (Linode) in Dallas**.

| Component          | Configuration                                                                         |
| ------------------ | ------------------------------------------------------------------------------------- |
| Application        | SvelteKit, Svelte 5 runes, TypeScript, Tailwind, Zod                                  |
| Web container      | `doclifts-web`; Node 24 Alpine, adapter-node, production dependencies                 |
| Database container | `doclifts-db`; PostgreSQL 16, Drizzle ORM and migrations                              |
| Compose services   | `web` and `db`, project `doclifts`                                                    |
| Persistence        | Named volume `doclifts_pgdata` (normally `doclifts_doclifts_pgdata` for this project) |
| Access             | Web port 3000 published only on the configured Tailscale IP                           |
| Database network   | Service name `db`, port 5432 on the Compose network; no host port published           |
| Health checks      | `pg_isready` for the DB; HTTP GET on `127.0.0.1:3000` inside the web container        |

The Dockerfile has builder and runtime stages. The builder installs locked dependencies and runs `pnpm build`. The runtime installs production dependencies, including `drizzle-orm` and `postgres`, copies the built app, and starts `node .` from `/app/build`.

The old systemd/release-symlink deployment and Tailscale Serve configuration are historical, not the VPS deployment path. Legacy deployment scripts and `deploy/doclifts.service` are not instructions for updating this Compose stack.

### Access and authentication

There is no application login. Access is restricted through Tailscale; do not publish the web port on a public interface. Authentication is required before introducing public access.

The VPS currently serves HTTP inside the encrypted tailnet. An app-specific Tailscale identity and HTTPS address are planned, not configured by this repository. As of the September 13 inspection, the old app-specific HTTPS bookmark still reached the earlier server. Confirm the destination before assuming a bookmark reaches the VPS.

CSRF checking remains enabled. `svelte.config.js` allowlists the supported tailnet origins, and Compose sets the runtime `ORIGIN` from `PUBLIC_ORIGIN`. When changing the browser-facing address, update both the allowlist and environment and rebuild the web image. Changing `PUBLIC_ORIGIN` alone does not change the published port binding or Tailscale DNS.

## Configure the VPS stack

Prerequisites: Docker Engine with Compose, an active Tailscale connection, and permission to use Docker. Run the following Linux shell commands from the repository root.

`docker-compose.yml` is configured for the existing VPS: its web port binding contains that machine's tailnet IP. On a different host, change the binding to that host's Tailscale IP and update the trusted origins. Do not replace the binding with `0.0.0.0`.

Production's env file is created **outside the repository** — by default
`/srv/doclifts/.env`, overridable with `DOCLIFTS_PROD_ENV`. Never create it in
the checkout and never symlink the checkout's `.env` to it: the checkout is the
working copy for tests and tooling, and a symlink makes every tool run here read
production credentials by default.

```sh
sudo install -m 600 -o "$USER" /dev/null /srv/doclifts/.env
sudoedit /srv/doclifts/.env
```

```dotenv
POSTGRES_PASSWORD=REPLACE_WITH_A_STRONG_URL_SAFE_PASSWORD
PUBLIC_ORIGIN=http://YOUR_TAILSCALE_HOSTNAME:3000
```

Use the same password in both values. The Compose web service constructs its
own database URL from `POSTGRES_PASSWORD`; `scripts/migrate-prod.sh` constructs
the same URL for migration commands, so **no `DATABASE_URL` needs to be present
in this file or exported by hand.** `db` resolves inside the Compose network,
not from a host development process.

The development checkout has its own `.env`, created from `.env.example`. It
points at the development and test databases and deliberately omits
`POSTGRES_PASSWORD`, so a bare `docker compose` run from the checkout fails on
the missing variable instead of silently reusing production's.

Protect the production env file with restrictive file permissions (mode 600) and
never commit it.

Changing `POSTGRES_PASSWORD` in `.env` does not change the password of an already-initialized PostgreSQL volume. Coordinate database credential changes separately.

## Build, migrate, and start

For a new empty installation:

```sh
scripts/compose-prod.sh up -d --wait db
scripts/migrate-prod.sh
scripts/compose-prod.sh up -d --build --wait web
```

Both scripts pass the production env file explicitly, so the checkout's `.env`
is never consulted. `scripts/migrate-prod.sh` takes a verified pre-migrate dump
before it applies anything, and refuses to migrate if that dump fails or cannot
be parsed.

The migration runner uses the builder image because the slim web runtime does not include the migration tooling or source migration directory. Run migrations through Drizzle so its migration journal stays consistent. Startup does not automatically migrate, seed, or import personal history.

Create a program through the UI for a new personal installation. The default seed now supplies fictional demo data only and refuses to run against a production database. Use the separate [demo stack](docs/demo.md) to try sample workouts.

The VPS migration used the legacy Docker builder to work around a host build-environment issue. If that same issue occurs on the existing host, prefix the build commands with `DOCKER_BUILDKIT=0`; it is not a requirement for every Docker installation.

### Updating an existing deployment

1. Check `git status`, preserve concurrent work, and use `git pull --ff-only` to obtain the intended release.
   The web container will not start without `BETTER_AUTH_SECRET`: the server
   graph throws at module load, so the process exits before the listener opens.
   The healthcheck and the container logs name the variable. This is boot-time
   on purpose — better than failing on the first request, because no traffic is
   ever served on a broken auth config.
2. If there are new migrations, run `scripts/migrate-prod.sh` — it dumps and verifies a backup first, then applies them. Review compatibility with the running app before applying schema changes.
3. Build the web image with `scripts/compose-prod.sh build web` while the existing app runs.
4. Switch the web container with `scripts/compose-prod.sh up -d --no-deps --no-build --wait web`.
5. Verify health, open the app from an actual tailnet device, and check the affected user flow.
6. If this release included `0011_ownership_not_null`, run `scripts/user-prod.sh bootstrap --email you@example.com --password '...'` **before** signing in. Every pre-existing row was backfilled to a placeholder owner; bootstrap claims that sentinel for a real account, keeping its id so the backfilled rows stay attached. Until it runs, the app loads with a single sentinel-owned dataset rather than your own history. See `docs/migrations.md` §0011, including why 0011 is not worth reverting once bootstrap has claimed the rows.

Rollback is a documented manual step, not automatic:

```sh
docker exec -i doclifts-db pg_restore --clean --if-exists --no-owner --no-privileges \
  -U doclifts -d doclifts < /srv/doclifts/backups/predeploy-<timestamp>.dump
```

`--clean` drops only objects present in the dump, so objects a migration
_created_ (the `auth` schema, the ownership columns) survive a restore and need
explicit drops — see `docs/migrations.md`.

### Accounts

There is no sign-up UI in this release and no email flow of any kind. Every
account is created by an operator, on the server, with these three commands:

| Command                                                              | What it does                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm user:bootstrap --email <addr> --password <pw> [--name "Name"]` | **The required first-run step after migration 0011.** Claims the 0011 sentinel — a placeholder row with no password that every backfilled row points at — for a real account, keeping its id so the existing workouts stay attached. On a database with no sentinel, creates a fresh account instead. Refuses if real users already exist. |
| `pnpm user:create --email <addr> --password <pw> --name "Name"`      | Adds an account to a database already in use.                                                                                                                                                                                                                                                                                              |
| `pnpm user:set-password --email <addr> --password <pw>`              | Replaces an account's password. There is no password-reset email, so this is how a locked-out account is fixed.                                                                                                                                                                                                                            |

Every new account starts with a 23-exercise starter list, added automatically.

Locally these run with `pnpm user:…` (they read `.env`). In production, run
them through `scripts/user-prod.sh`, which builds `DATABASE_URL` from the
production env file and runs the command on the Compose network inside the
builder image — the runtime image has no `tsx`:

```sh
scripts/user-prod.sh bootstrap --email you@example.com --password '...'
```

The password is visible in the process list while the command runs. That is
fine for an operator tool run by hand over SSH; do not put one in a script or a
CI job.

A Git push does not itself establish that the VPS has rebuilt. The checked-in GitHub workflows run CI; follow the deployment steps unless a separate deployment trigger has been configured and verified.

## Operations and backups

```sh
docker compose -p doclifts ps
docker compose -p doclifts logs --tail=100 web
docker compose -p doclifts logs --tail=100 db
docker compose -p doclifts exec db pg_isready -U doclifts -d doclifts
docker compose -p doclifts exec web wget -qO- http://127.0.0.1:3000/
```

Open `http://<configured-tailnet-host>:3000/` from a device connected to the tailnet. Container health confirms basic serving; it does not prove that every form, bookmark, or client can reach the intended deployment.

`scripts/backup-db.sh` dumps the production container to `/srv/backups/doclifts/doclifts-YYYY-MM-DD.sql.gz`. It promotes a completed dump and then prunes backups older than 30 days. The executing account needs Docker access and write access to that directory. Daily scheduling is a host cron responsibility; `docker compose up` does not install the cron job.

```sh
bash scripts/backup-db.sh
```

Before relying on a backup, restore it into an isolated test database and verify its contents. Do not restore over the live database merely to test a dump. Restores were exercised during development/import validation; verify current backups independently. Keep private dumps outside Git. Avoid `docker compose down -v`: it removes this stack's persistent database volume.

## Local development and tests

The production Compose file does not publish PostgreSQL to the host and is tied to the VPS tailnet binding. For a host-based development server, use a separate local database container and volume:

```sh
docker run -d --name doclifts-dev-db \
  -e POSTGRES_USER=doclifts -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=doclifts \
  -p 127.0.0.1:55432:5432 \
  -v doclifts_dev_pgdata:/var/lib/postgresql/data postgres:16
```

On a new checkout, copy `.env.example` to `.env` and change both URLs to the local port:

```dotenv
DATABASE_URL=postgresql://doclifts:dev@127.0.0.1:55432/doclifts
TEST_DATABASE_URL=postgresql://doclifts:dev@127.0.0.1:55432/doclifts_test
```

Use Node 24 and the pnpm version pinned in `package.json`. Wait until the database accepts connections, then:

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm exec playwright install chromium
pnpm check
pnpm test
pnpm dev
```

Integration tests create/use the separate test database and reset its tables. Never point `TEST_DATABASE_URL` at production. `pnpm build` builds the application; the Dockerfile builds the deployable container image.

## Project guidance

`CLAUDE.md` records application invariants and coding conventions. Its older references to cloud deployment being out of scope, backup paths, and systemd hosting predate the owner-approved VPS migration; use the checked-in Compose/Docker configuration and this README for current operations.

## License

Copyright 2026 Enoch AI LLC. Licensed under the [Functional Source License, Version 1.1, ALv2 Future License](./LICENSE) (FSL-1.1-ALv2). Each version converts to the Apache License, Version 2.0 on the second anniversary of its release. Versions 0.1.0 and earlier were released under Apache-2.0 and remain so. See [NOTICE](./NOTICE) for attribution.
