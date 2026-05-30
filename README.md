# DocLifts

[![CI](https://github.com/cjenoch/DocLifts/actions/workflows/ci.yml/badge.svg)](https://github.com/cjenoch/DocLifts/actions/workflows/ci.yml)

A single-user weightlifting log — a phone-at-the-gym tool that prescribes the next set and records what actually got done. Self-hosted, no cloud, no third-party accounts.

This repository is the reference build behind a case study on multi-tool, AI-assisted development: [DocLifts — A Multi-LLM Development Process](https://enoch.ai/case-studies/doclifts/). The app itself is deliberately modest. What's worth reading here is the engineering discipline around it.

## What's worth looking at

- **A real production concurrency bug, fixed in three layers.** A day-one race let a double-tapped *Start* button open two sessions for the same day. The fix isn't a single patch — it's defense at three layers, because any one layer can be bypassed:
  - a partial unique index in the database — `sessions_one_open_per_day ON sessions(day_id) WHERE ended_at IS NULL` (migration `0001`)
  - an idempotent server-side helper, `startSessionForDay`
  - a client-side guard on the Start control
- **A test suite, not decoration.** Vitest across unit, component, and database-integration paths, plus browser tests. The day-one race is regression-locked so it can't come back silently. On every push, CI runs the server/data suite against a real Postgres; browser tests run in a dedicated Browser CI workflow (push + nightly). The test story is auditable, not "trust me."
- **Backups that are restore-tested, not just configured.** Daily `pg_dump`, with the restore path actually exercised. "Configured" is never treated as "working."
- **Written invariants over memory.** `CLAUDE.md` holds the operating rules that kept several AI tools coherent across the build; the design decisions live in version-controlled docs, not in any one tool's session memory.

## By design (threat model)

DocLifts is single-user and self-hosted, served over [Tailscale](https://tailscale.com) and never exposed to the public internet. A few choices that would be wrong for a public app are deliberate here:

- **No authentication.** One user on a private tailnet. There's no login because there's no second user.
- **`csrf: false`.** With a Tailscale-only origin allowlist (`trustedOrigins` in `svelte.config.js`) and no public surface, CSRF protection would guard a threat the network model already excludes.

These are scope decisions, documented in `CLAUDE.md` — not oversights. Taking the app out of this threat model (e.g., exposing it publicly) means re-adding auth and CSRF protection first.

## Stack

- **App:** SvelteKit (Svelte 5, runes), TypeScript, Vite, Tailwind
- **Data:** PostgreSQL 16, Drizzle ORM, Zod validation
- **Runtime:** `@sveltejs/adapter-node` as a systemd service, fronted by Tailscale Serve over HTTPS, on an Ubuntu VM (Node 24, pnpm)
- **Ops:** daily `pg_dump` backups with a verified restore path

## Running it

Postgres and (for the browser tests) Playwright are prerequisites — without them the database-integration tests skip and the browser tests fail to launch on a fresh clone:

```sh
pnpm install --frozen-lockfile
docker compose up -d postgres          # database-integration tests need this
pnpm exec playwright install chromium  # browser tests need this

pnpm test                              # full suite (client + server)
pnpm run dev                           # local dev server
pnpm run build                         # production build
```

> Local development and CI both use pnpm (`--frozen-lockfile`) per `CLAUDE.md`.

## License

All rights reserved — see [LICENSE](./LICENSE). The source is published for reference and evaluation only. It is not open source and is not licensed for reuse.
