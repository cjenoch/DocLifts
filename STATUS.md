# DocLifts — current status

Updated October 4, 2026. Current application: **0.18.4 Alpha**, runtime `5b9203d`.
Deployed and automatically verified; owner phone/agent acceptance pending.
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

Deployed October 4, 2026 on 5b9203d (tag 0.18.4) after PR37 and exact-head
CI37241672588. Full local lint/types/Drizzle/build, 905 server tests (+2 expected
private-data skips), 42 component tests and 159 browser tests passed. A final
assertion cleanup also passed lint/types/build and 35 CSP/privacy scenarios.

The [public privacy notice](https://doclifts.runthe.ai/privacy) is linked from
sign-in and Account. New uploads require account-scoped, versioned acknowledgment
before processing, screening or storage. Existing users acknowledge before their
next new photo; manual logging remains available. The notice explicitly covers
operator/provider access, agent notes, browser storage, backups and unfinished
retention/deletion/export work. See [privacy controls](docs/privacy.md).

Migration 0021 passed on a fresh production-backup restore with unchanged aggregate
counts, 25 photo hashes, seven SQLite checks and isolated scratch login/history.
The production wrapper took and verified an immediate dump, then migrated. Its
first attempt safely refused the root-owned backup directory; sudo was required.
All existing accounts remained unacknowledged after migration.

Public automation-account checks verified the new build and notice, direct-upload
refusal, acknowledgment without losing an unsaved set, normal saving, four layouts,
hidden fields, set editing, rejected uploads, history, update detection, MCP's
unauthenticated challenge and logout invalidation of a saved session cookie.
Previous recovery images are retained. No host reboot or provider/settings change.
The prior dependency batch remains documented in [dependency triage](docs/dependencies.md).

Private evidence: ops/privacy-2026-10-04 in the VPS-only operations repository.
See [release records](docs/release-0.2.0.md). Owner phone/agent acceptance remains
separate; automated checks do not establish every client's compatibility or the
correctness of training interpretation.

## Host maintenance

October 4: 34 host packages upgraded and 7 kernel packages installed, then a
verified reboot into kernel 7.0.0-38 and Docker 29.8.2. Production containers and
backup timers recovered, the classifier passed generated-image/invalid-input
checks, and no failed system or user units remained. Ubuntu deferred one phased
audio configuration update. Host updates do not resolve JavaScript dependency
advisories. Signup stays closed.

## Next work, not shipped

- Complete replacement-VPS recovery rehearsal and external host-down monitoring.
  Encrypted off-host backup automation and an isolated data/app restore drill are
  complete; production still runs on one VPS.
- Follow up the remaining moderate advisory when Drizzle replaces its loader, or
  before changing how database tooling is run; see [dependency triage](docs/dependencies.md).
  Deeper independent OAuth review, measured capacity tests and existing security
  follow-up before widening Alpha access. Screening does not solve prompt injection.
- Account export/deletion, saved-photo deletion and automatic
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
