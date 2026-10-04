# DocLifts — current status

Updated October 4, 2026. Current application: **0.18.0 Alpha**, runtime `f1eff6f`.
Resolve current documentation HEAD with `git rev-parse --short HEAD`; a later
Markdown merge does not require rebuilding the application.

## Live

- [App](https://doclifts.runthe.ai): separate accounts, photo-assisted machine
  identification, per-machine history, editable programs and workout logging.
- [MCP endpoint](https://doclifts-mcp.runthe.ai/mcp): eight account-scoped read tools,
  including bulk app sets and imported notebook history. OAuth consent, optional
  notes, refresh and revocation are implemented. The Muse chat app has made
  successful reads of both history collections; its notes permission is approved.
- Image screening runs before persistent storage and vision identification, with
  controlled local/OpenRouter A/B testing. Failed screening refuses the upload.
- Android and iPhone sign-in were owner-tested. Signup remains closed; Alpha
  accounts are operator-managed. The old disposable demo is retired.

## Deployment and evidence

SvelteKit/Node 24 and PostgreSQL 16 run in Docker Compose on the VPS, reached
through Cloudflare Tunnel. The old systemd/release-symlink deployment is retired.
Use the production wrappers and rules in [CLAUDE.md](CLAUDE.md).

Deployed October 4, 2026 on `f1eff6f` (tag `0.18.0`) after PR23, full local
lint/types/Drizzle/build, 902 server tests (+2 expected private-data skips),
42 component tests and 176 browser tests. Exact-head CI37212527852 passed.
The fresh encrypted snapshot ca7887f8 restored with matching database totals,
24 photo hashes, seven SQLite integrity checks and scratch login/history.
Recovery images including pre-0.18.0 and earlier releases are retained.
Public Alpha scratch checks passed all four layouts, distinct drafts, hidden
zero RIR/notes, saving/reload, append/remove empty set, timer settings, 320/390px
fit and finish/history. No schema, auth or tunnel changes. Owner gym/phone
acceptance is pending; automated checks do not confirm actual phone audio.

Private evidence is in `ops/workout-layouts-2026-10-04` in the VPS-only
operations repository. See [release records](docs/release-0.2.0.md).

Actual client read success is not a guarantee of complete pagination or correct
training analysis. Other agent clients and owner interpretation review remain
separate acceptance work.

## Host maintenance

October 4: 34 host packages upgraded and 7 kernel packages installed, then a
verified reboot into kernel 7.0.0-38 and Docker 29.8.2. Production containers and
backup timers recovered, the classifier passed generated-image/invalid-input
checks, and no failed system or user units remained. Ubuntu deferred one phased
audio configuration update. Host updates do not resolve JavaScript dependency
advisories. Signup stays closed.

## Release in progress

0.18.1 removes the global mode switch and adds visible release/build identity
and an explicit refresh prompt. Implemented; deployment checks pending.

## Next work, not shipped

- Complete replacement-VPS recovery rehearsal and external host-down monitoring.
  Encrypted off-host backup automation and an isolated data/app restore drill are
  complete; production still runs on one VPS.
- JavaScript dependency advisory remediation, deeper independent OAuth review, measured capacity tests and existing security
  follow-up before widening Alpha access. Screening does not solve prompt injection.
- Account export/deletion, saved-photo deletion, privacy/upload notices and
  retention rules covering logs, backups and provider processing before public signup.
- Signup/approval gates and fuller beginner onboarding. Four workout layouts and the
  first-set guide are live; owner gym acceptance remains pending.
- Explicit test/training labels; richer import/export and reviewed notebook
  ingestion. Existing imported history is readable, not a self-service importer.
- Beginner machine guidance and further client compatibility checks.
- After gym feedback, refactor remaining workout orchestration and audit slow or
  redundant tests while preserving security and data-integrity regressions.

See [application overview](APP_DOCS.md), [MCP guide](docs/mcp-alpha.md),
[README](README.md) and [changelog](CHANGELOG.md). Historical status and design
notes remain in Git history; they are not current deployment instructions.
