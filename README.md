# DocLifts

[![CI](https://github.com/cjenoch/DocLifts/actions/workflows/ci.yml/badge.svg)](https://github.com/cjenoch/DocLifts/actions/workflows/ci.yml)

A single-user weightlifting log — a phone-at-the-gym tool that prescribes the next set and records what actually got done. Self-hosted, no cloud, no third-party accounts.

This repository is the reference build behind a case study on multi-tool, AI-assisted development: [DocLifts — A Multi-LLM Development Process](https://enoch.ai/case-studies/doclifts/). The app itself is deliberately modest. What's worth reading here is the engineering discipline around it.

## What's worth looking at

- **A real production concurrency bug, fixed in three layers.** A day-one race let a double-tapped *Start* button open two sessions for the same day. The fix isn't a single patch — it's defense at three layers, because any one layer can be bypassed:
  - a partial unique index in the database — `sessions_one_open_per_day ON sessions(day_id) WHERE ended_at IS NULL AND deleted_at IS NULL` (migration `0001`)
  - an idempotent server-side helper, `startSessionForDay`, that catches the unique-violation and returns the race winner
  - a client-side guard on the Start control
  And it's regression-locked by a test that fires concurrent starts and asserts they converge to one open session.
- **A server/data test suite that's real, not decoration.** The full Vitest suite — 120+ and counting — runs against real Postgres in CI, nothing skipped: the concurrency test above, plus snapshot semantics and history filtering. A separate Browser CI workflow (push + nightly) runs the component harness, though UI-flow coverage is still thin.
- **Backups that are restore-tested, not just configured.** Daily `pg_dump`, with the restore path actually exercised. "Configured" is never treated as "working."
- **Written invariants over memory.** `CLAUDE.md` holds the operating rules that kept several AI tools coherent across the build; the design decisions live in version-controlled docs.

## By design (threat model)

DocLifts is single-user and self-hosted, served over [Tailscale](https://tailscale.com) and never exposed to the public internet. The security posture is shaped to that model:

- **No authentication.** One user on a private tailnet — there's no login because there's no second user. This is the choice that would be wrong for a public app, so re-adding auth is the first step if it's ever exposed.
- **CSRF stays on, scoped to one origin.** `csrf: { trustedOrigins: [...] }` in `svelte.config.js` allowlists the canonical Tailscale Serve URL — origin checking is enabled (it even 403s requests with no `Origin` header), just pinned to the single hostname the app is served from. It is not disabled; update the list if the app moves.

These are scope decisions, documented in `CLAUDE.md` — not oversights.

## Stack

- **App:** SvelteKit (Svelte 5, runes), TypeScript, Vite, Tailwind
- **Data:** PostgreSQL 16, Drizzle ORM, Zod validation
- **Runtime:** `@sveltejs/adapter-node` as a systemd service, fronted by Tailscale Serve over HTTPS, on an Ubuntu VM (Node 24, pnpm)
- **Ops:** daily `pg_dump` backups with a verified restore path

## Running it

Create `.env` first, then bring up Postgres and (for the browser harness) Playwright:

```sh
cp .env.example .env                   # then set DATABASE_URL (and TEST_DATABASE_URL)
pnpm install --frozen-lockfile
docker compose up -d postgres          # database-integration tests need this
pnpm exec playwright install chromium  # browser harness needs this

pnpm test                              # full suite (server + client projects)
pnpm run dev                           # local dev server
pnpm run build                         # production build
```

> Local development and CI both use pnpm (`--frozen-lockfile`) per `CLAUDE.md`.

## License

All rights reserved — see [LICENSE](./LICENSE). The source is published for reference and evaluation only. It is not open source and is not licensed for reuse.
