# DocLifts — Document your Lifts

[![CI](https://github.com/cjenoch/DocLifts/actions/workflows/ci.yml/badge.svg)](https://github.com/cjenoch/DocLifts/actions/workflows/ci.yml)

**Photograph a machine. Log your sets. See your progress.**

DocLifts is a workout log built around the equipment you actually use. Take a picture, start recording sets while identification runs, and review the machine match when you are ready. AI helps with identification; you stay in control of your workout.

**[Open DocLifts Alpha](https://doclifts.runthe.ai)** · [Release history](CHANGELOG.md) · [Contributing](CONTRIBUTING.md)

The hosted app is live on Android, iPhone and desktop browsers. Alpha access is currently operator-managed; public signup is closed. This is an actively developed test system. The former disposable demo has been retired.

## Built for the workout

- **Know your build.** The release/build is visible on sign-in and in the app header. A newer build offers a refresh prompt; Account has a manual update check.
- **Choose your workout view.** Guided, Set table, Notebook and Tap sets share the same workout. Customize effort, notes and previous performance per account/program in your browser. Edit workout exposes session controls; the clock opens optional timer alerts.
- **Photo first, keep lifting.** A photo opens a workout block so you can log before identification completes. Review uncertain matches; a failed identification does not prevent manual logging. Previously used machines can be recognized from an agreeing placard code and name, with an undo option.
- **History belongs to the right equipment.** Machines keep their own performance history. Free-weight exercise history follows you between gyms. Weight conventions distinguish total weight, per-hand and per-side loads.
- **Programs you can change.** Start with Traveling PPL, Barbell Strength, Machine Full Body, or Machines and Dumbbells, then edit days, exercises and sets. Phone-oriented Program → Day → Exercise screens retain drafts through reloads.
- **Adapt during a session.** Add, move, remove, skip or swap exercises. “Just today” and “From now on” separate a workout adjustment from a program change. Record warmups, working sets, backoffs and set notes.
- **Progression with an explanation.** Suggested loads use completed training history, the exercise's progression policy and equipment-aware plate calculations. You can override them. The progression engine is deterministic and does not need an LLM.
- **A usable training record.** Review history and reports, edit recorded workouts, and restore workouts from Trash. Prescriptions are snapshotted so later program changes do not rewrite what was planned for a past session.
- **Your account, your records.** Application sign-in and owner-scoped data access separate users' workouts, programs, gyms and machines. Each new account starts with an editable exercise list.

Set drafts remain in the current browser tab until saved; they are not synced workout records. Finishing a workout prompts you to save unfinished entries first.

## AI that assists

Photo uploads are rebuilt as cleaned images in memory, then screened before storage and identification. A rejected image is not stored; scanner failures refuse the upload. Manual workout logging remains available. Local and OpenRouter safety providers support controlled A/B testing. See [photo safety](docs/photo-safety.md).

Identification requests go through one model-call interface with structured-output validation, timeouts, per-user limits and usage records. A machine match is a suggestion, not an instruction to change a saved set. See [the model-call interface](docs/llm.md) and [machine identity](docs/machine-identity.md).

## Your data beyond the app

**MCP is live in 0.17.0 Alpha.** Connect an agent at `https://doclifts-mcp.runthe.ai/mcp`, sign in to DocLifts, and approve account-scoped read access. Notes are optional; revoke access from Account → Connected agents. The Muse chat app has successfully read both app workouts and imported history, with notes access authorized. Other clients still need individual verification.

Eight read-only tools cover workouts, bulk set history, imported notebooks, programs, equipment and a data dictionary. Bulk reads avoid opening every workout separately. Original notebook text, explicit-versus-estimated evidence, uncertain dates, weight conventions and historical machine context remain available for interpretation. Read [the MCP guide](docs/mcp-alpha.md) for setup, scopes, tool names and pagination.

Imported records remain separate from app sessions and do not feed automatic progression or operational workout totals. The collections can overlap; an agent should not blindly add their totals. App entries can also contain tests or incomplete sets. Personal import payloads stay outside this repository.

Self-service notebook ingestion, portable full-data import/export, custom fields, and beginner machine guidance/videos are planned work, not current features. The intended direction is straightforward: document your training in a form you can understand, keep and use elsewhere.

## Privacy during the Alpha

Read the [privacy notice](https://doclifts.runthe.ai/privacy) before uploading photos or connecting an agent. Photos require an account-level acknowledgment before processing; manual logging stays available. The notice explains operator/provider access and the current limits around retention, export and deletion. Those controls are still being completed before public signup; see [privacy implementation and remaining work](docs/privacy.md).

## How it runs

| Layer          | Implementation                                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| App            | SvelteKit, Svelte 5, TypeScript, Tailwind and Zod                                                                                      |
| Runtime        | Node 24, adapter-node, Docker Compose                                                                                                  |
| Data           | PostgreSQL 16, Drizzle schema and append-only migrations                                                                               |
| Authentication | Better Auth, host-only session cookies and server-side ownership checks                                                                |
| Photos         | Private S3-compatible storage; safety screening before storage                                                                         |
| Public access  | Cloudflare Tunnel to the VPS; the database has no public port                                                                          |
| Quality checks | Formatting, type checks, migration checks, PostgreSQL integration tests, browser component tests and production-build end-to-end tests |

Production runs on an Akamai Cloud (Linode) VPS. The tunnel provides public access; it does not provide a second application server or database. Encrypted off-host backups are scheduled, with an isolated restore drill completed. A complete replacement-VPS recovery and measured launch-capacity targets remain unverified; backups are not redundancy.

Application source and fictional test fixtures live here. Credentials, personal workout data, production dumps and private host configuration do not. See [private-data policy](docs/private-data.md).

## Local development

Use the pnpm version pinned in `package.json`. `pnpm install --frozen-lockfile` installs the project's pinned Node 24.21.0 runtime as well as dependencies; all `pnpm run` and `pnpm exec` commands then use it. A different Node on your shell PATH does not need to be replaced. For standalone Node scripts, use `pnpm exec node` instead of bare `node`. CI reads the matching `.node-version` pin, and both Docker stages use the same patch version. Start an isolated PostgreSQL instance for development; never point test tooling at production:

```sh
docker run -d --name doclifts-dev-db \
  -e POSTGRES_USER=doclifts -e POSTGRES_PASSWORD=dev-only -e POSTGRES_DB=doclifts \
  -p 127.0.0.1:55432:5432 \
  -v doclifts_dev_pgdata:/var/lib/postgresql/data postgres:16
cp .env.example .env
```

Set these development values in `.env`, and generate a separate local `BETTER_AUTH_SECRET` as described there:

```dotenv
DATABASE_URL=postgresql://doclifts:dev-only@127.0.0.1:55432/doclifts
TEST_DATABASE_URL=postgresql://doclifts:dev-only@127.0.0.1:55432/doclifts_test
PUBLIC_ORIGIN=http://localhost:5173
```

Once PostgreSQL is ready:

```sh
pnpm install --frozen-lockfile
pnpm exec node --version # v24.21.0
pnpm db:migrate
pnpm user:bootstrap --email lifter@example.invalid --password-stdin
pnpm exec playwright install chromium
pnpm dev
```

The account command reads the password from standard input. Create a program through the app; there is no demo seed command. Photo identification requires additional provider/storage settings from `.env.example`; manual logging does not require an AI provider.

The full development gate is:

```sh
pnpm lint
pnpm check
pnpm exec node --env-file=.env node_modules/drizzle-kit/bin.cjs check
pnpm run test:unit --project server
pnpm run test:unit --project client
pnpm build
CI=1 pnpm test:e2e
```

Integration tests create/reset the separate test database. Browser tests need Chromium; `PW_EXECUTABLE_PATH` can select an installed browser. `CI=1` makes missing browser/build prerequisites fail instead of silently skipping coverage. See [contribution guidance](CONTRIBUTING.md) and [project rules](CLAUDE.md).

## Deployment and operations

This repository's Compose configuration targets the existing VPS. It is not a generic one-command public installation. Review its private-interface binding and the [public-address guide](docs/public-address.md) before adapting it to another host.

Production secrets live outside the checkout, normally in `/srv/doclifts/.env`, with restrictive permissions. Use `scripts/compose-prod.sh`, `scripts/migrate-prod.sh` and `scripts/user-prod.sh` on the VPS; they pass the production environment explicitly. Never symlink a development `.env` to the production file. Every runtime setting needs its Compose passthrough.

A Git push runs CI; it does not deploy the app. Releases require a green local gate and branch CI, a verified backup/restore rehearsal for migrations, retention of the previous image, and checks against the real public screens using a scratch account. The current owner-authorized development cycle permits fixing forward without routine approval holds or automatic rollback, while retaining at least two recovery images. Phone and real-agent acceptance are recorded separately from deployment.

Useful references:

- [Release log and acceptance](docs/release-0.2.0.md)
- [Migrations and recovery](docs/migrations.md)
- [Public address and tunnel](docs/public-address.md)
- [Photo storage](docs/photos.md) and [screening](docs/photo-safety.md)
- [Equipment catalog](docs/catalog.md) and [program editor](docs/program-builder.md)

Backups must be restored and checked in isolation before they are relied on. Never test a restore over the live database or use `docker compose down -v` on a production stack.

## License

Copyright 2026 Enoch AI LLC. Source-available under the [Functional Source License, Version 1.1, ALv2 Future License](LICENSE) (FSL-1.1-ALv2). Each version converts to Apache-2.0 on the second anniversary of its release. Versions 0.1.0 and earlier remain Apache-2.0. See [NOTICE](NOTICE) and [contribution terms](CONTRIBUTING.md).
