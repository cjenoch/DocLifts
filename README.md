# DocLifts

[![CI](https://github.com/cjenoch/DocLifts/actions/workflows/ci.yml/badge.svg)](https://github.com/cjenoch/DocLifts/actions/workflows/ci.yml)

A single-user weightlifting log for training across gyms: record what you lifted, get suggestions for the next set, and keep your training history together. Self-hosted on a private VPS with Docker Compose and Tailscale access.

This is the personal project behind [DocLifts — Training, AI-Assisted Development, and QA](https://enoch.ai/case-studies/doclifts/). AI tools support development and review; the app's training logic does not depend on an LLM.

## Features and engineering

- Machine identity, equipment-aware plate snapping, and session quick-add.
- MAIN backoff suggestions derived from the top set actually performed.
- A drag-and-drop program editor with transactional draft handling and a Traveling Push/Pull/Legs preset.
- Workout history editing, soft deletion, and restoration.
- A searchable imported-history archive at `/imported-history`. Original notes, recalled estimates, and uncertain dates are preserved. Archive records do not feed progression or operational workout-report totals. The September 2026 import added 107 records without changing the existing 31 sessions and 467 sets. Personal import payloads are not distributed in this repository.
- Session-start concurrency protection in the interface, server, and database, backed by an integration test.
- Server tests against PostgreSQL and a separate browser/component CI workflow. Consult the workflows and their results for current coverage rather than a fixed test-count claim.

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

Create an uncommitted `.env` for a **new** installation. Preserve an existing deployment's credentials; do not overwrite its `.env` with the development example.

```dotenv
POSTGRES_PASSWORD=REPLACE_WITH_A_STRONG_URL_SAFE_PASSWORD
DATABASE_URL=postgresql://doclifts:REPLACE_WITH_THE_SAME_PASSWORD@db:5432/doclifts
PUBLIC_ORIGIN=http://YOUR_TAILSCALE_HOSTNAME:3000
```

Use the same password in both values. The Compose web service constructs its own database URL from `POSTGRES_PASSWORD`; the separate `DATABASE_URL` above is used by migration commands. `db` resolves inside the Compose network, not from a host development process. Protect `.env` with restrictive file permissions and never commit it.

Changing `POSTGRES_PASSWORD` in `.env` does not change the password of an already-initialized PostgreSQL volume. Coordinate database credential changes separately.

## Build, migrate, and start

For a new empty installation:

```sh
docker compose -p doclifts up -d --wait db
docker build --target builder -t doclifts-migrations:local .
docker run --rm --network doclifts_default --env-file .env \
  doclifts-migrations:local pnpm db:migrate
docker compose -p doclifts up -d --build --wait web
```

The migration runner uses the builder image because the slim web runtime does not include the migration tooling or source migration directory. Run migrations through Drizzle so its migration journal stays consistent. Startup does not automatically migrate, seed, or import personal history.

For a new empty database only, the optional program seed can run in the same builder image:

```sh
docker run --rm --network doclifts_default --env-file .env \
  doclifts-migrations:local pnpm exec tsx src/lib/server/db/seed.ts
```

Do not seed a populated production database as part of a routine deploy. Review the seed before using it.

The VPS migration used the legacy Docker builder to work around a host build-environment issue. If that same issue occurs on the existing host, prefix the build commands with `DOCKER_BUILDKIT=0`; it is not a requirement for every Docker installation.

### Updating an existing deployment

1. Save and verify a fresh backup before schema/data changes.
2. Check `git status`, preserve concurrent work, and use `git pull --ff-only` to obtain the intended release.
3. Build the web image with `docker compose -p doclifts build web` while the existing app runs.
4. If there are new migrations, rebuild the builder image and run the migration command above. Review compatibility with the running app before applying schema changes.
5. Switch the web container with `docker compose -p doclifts up -d --no-deps --no-build --wait web`.
6. Verify health, open the app from an actual tailnet device, and check the affected user flow.

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

All rights reserved — see [LICENSE](./LICENSE). The source is published for reference and evaluation only. It is not open source and is not licensed for reuse.
