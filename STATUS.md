# DocLifts — current status

Updated October 24, 2026 UTC. Current application: **0.18.5 Alpha**, runtime `cceb608`.
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

Operations build `cceb608` deployed October 24, 2026 UTC after PR42. The app
label stays 0.18.5 Alpha, with the distinct runtime build visible in the GUI.
Exact-head CI40042604239 passed 958 server tests (3 expected skips), 42 components,
167 browser tests, lint, typecheck, Drizzle consistency, build, Docker and CodeQL.
The VPS server suite passed 961/961. Its initial browser run passed 162/167;
unchanged focused retries and independent laptop/CI runs passed affected cases.
The laptop full browser pass was 167/167. Timing failures remain follow-up work;
a cross-host pass alone does not isolate their cause.

Web now runs as uid 1000 with all capabilities dropped and no-new-privileges,
plus its existing read-only filesystem. `/health` runs a database readiness
query. The production wrapper requires an explicit trusted-edge declaration;
runtime rejects a mismatched Cloudflare/header pair. Private dump creation and
migration-only database credentials are enforced. Readiness shares one in-flight
probe; pool queue time is not bounded, and unhealthy does not mean auto-restarted.

JSON and URL-encoded password sign-ins now share the form's failure-only throttle.
Request bodies and concurrent password work are bounded. Email remains delay-only;
knowing someone's email cannot trigger an account-wide hard lock. MCP adds bounded
per-IP authentication work and a short-lived denied-token hash cache; successful
tokens still revalidate session and consent. See [auth hardening](docs/auth-hardening.md)
for restart, multi-instance, shared-IP and distributed-traffic limitations.

The October 23 encrypted snapshot passed an isolated restore with matching
database counts, photo hashes, seven SQLite checks and automation login/history.
A fresh pre-operations-deploy snapshot and full repository integrity check passed;
a second restore drill was not repeated for this schema-unchanged deployment.
The previous running image and older recovery images are retained. Only web was
recreated; no migration, host reboot, tunnel or provider-setting change.

Public checks used only the dedicated automation account. Browser and both direct
sign-in encodings, private pages, visible release/build, OAuth consent/PKCE/refresh,
MCP SDK tools and reads, token revocation, and logout invalidation passed. Owner and
human Alpha accounts were not exercised; no workout data was written.

The [privacy notice](https://doclifts.runthe.ai/privacy) and versioned upload
acknowledgment from 0.18.4 remain live. Self-service deletion/export and retention
remain unfinished; see [privacy controls](docs/privacy.md). Signup stays closed.

Private evidence: ops/ops-hardening-release-2026-10-24 and the earlier
ops/auth-release-2026-10-23 in the VPS-only operations repository. See
[release records](docs/release-0.2.0.md). Owner phone/agent acceptance remains
pending. Account/photo deletion and retention are being validated in draft PR41;
they are not deployed or activated.

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
