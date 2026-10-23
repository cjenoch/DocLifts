# DocLifts — current status

Updated October 23, 2026. Current application: **0.18.5 Alpha**, runtime `43a8f50`.
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

Deployed October 23, 2026 as 43a8f50 (tag 0.18.5), after PR39 and exact-head
CI40032121853 at 3036f8a. CI passed 922 server tests (3 skips), 42 component tests,
166 end-to-end tests, lint, typecheck, Drizzle consistency and build. Local server
coverage passed 923 tests (2 skips): two existing 5-second timeouts passed focused
retries without changing timeouts; CI skips a permission test when run as root.
Local e2e initially passed 163/166. An image-load race, an existing 5-second
consent wait timeout and its cascading leftover-consent failure recovered in one
fresh-fixture run of both affected suites (19/19), with unchanged assertions and
timeouts. All 166 cases are covered; test-timing repairs remain follow-up work.
Local components/build and CI Docker/runtime/CodeQL checks passed.

JSON and URL-encoded password sign-ins now share the form's failure-only throttle.
Request bodies and concurrent password work are bounded. Email remains delay-only;
knowing someone's email cannot trigger an account-wide hard lock. MCP adds bounded
per-IP authentication work and a short-lived denied-token hash cache; successful
tokens still revalidate session and consent. See [auth hardening](docs/auth-hardening.md)
for restart, multi-instance, shared-IP and distributed-traffic limitations.

A fresh encrypted off-host snapshot restored in isolation with matching database
counts, photo hashes, seven SQLite integrity checks and automation login/history.
The previous running image and older recovery images are retained. Only web was
recreated; no migration, host reboot, tunnel or provider-setting change.

Public checks used only the dedicated automation account. Browser and both direct
sign-in encodings, private pages, visible release/build, OAuth consent/PKCE/refresh,
MCP SDK tools and reads, token revocation, and logout invalidation passed. Owner and
human Alpha accounts were not exercised; no workout data was written.

The [privacy notice](https://doclifts.runthe.ai/privacy) and versioned upload
acknowledgment from 0.18.4 remain live. Self-service deletion/export and retention
remain unfinished; see [privacy controls](docs/privacy.md). Signup stays closed.

Private evidence: ops/auth-release-2026-10-23 in the VPS-only operations repository.
See [release records](docs/release-0.2.0.md). Owner phone/agent acceptance remains
pending. Hermes's separate infrastructure hardening is not part of this release.

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
