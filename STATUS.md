# DocLifts — current status

Updated October 24, 2026 UTC. Current application: **0.19.0 Alpha**, runtime `72b3d538`.
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
- Account deletion and saved-photo removal with durable
  off-host journal acknowledgment and bounded retries. Photo removal preserves
  recorded workout performance; account deletion removes the chosen account data.
- Android and iPhone sign-in were owner-tested. Signup remains closed; Alpha
  accounts are operator-managed. The old disposable demo is retired.

## Deployment and evidence

SvelteKit/Node 24 and PostgreSQL 16 run in Docker Compose on the VPS, reached
through Cloudflare Tunnel. The old systemd/release-symlink deployment is retired.
Use the production wrappers and rules in [CLAUDE.md](CLAUDE.md).

Runtime `72b3d538` deployed and deletion controls activated October 24, 2026 UTC after PR44.
Migrations 0022/0023 had already deployed at `5b6f9e3` with controls disabled;
the activation follow-up has no new migration. Exact-head CI40061488884 passed
974 server tests (3 expected skips), 42 components, 169 browser tests, lint,
typecheck, Drizzle consistency, build, Docker and CodeQL. All 11 Python/restic
checks passed, including ordinary-prune protection and union recovery.
The independent laptop full application gate passed 974 server tests, 42
components and 169 browser tests at `f8f03ff`; final `72b3d538` changes only
the disposable Python fixture file.
The final test-only fixture clarification also passed Python checks and lint;
its optional real-restic check passed on the VPS.

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

Before the lifecycle schema deployment, a fresh encrypted backup was retrieved
and its restored database migrated through 0023. Repeating migrations was a
no-op and aggregate counts were unchanged. A separate isolated deletion rehearsal
used real encrypted off-host journal records, restored the pre-deletion fixture
database, reconciled twice and preserved the unrelated account and photo. The
fixture photo store was in memory, with no live S3 credentials.

Public automation passed sign-in, OAuth/PKCE/refresh, MCP reads, revocation,
logout, visible build and 390px checks. A new disposable account removed a saved
photo through the UI while its logged set remained unchanged, then deleted the
account using the current password. Its old session was denied, cleanup completed,
both S3 fixture objects and owned account data were absent, and the public receipt
showed completion. All seven aggregate totals returned to their pre-fixture
baseline. The bucket has never had versioning enabled; actual S3
checks covered null versions. Historical versions/delete markers are fixture
coverage. Owner and human Alpha accounts were not destructive test fixtures.
Previous recovery images remain retained.

The private journal broker and pinned deletion worker keep backup credentials
outside web. A local-only five-minute health monitor checks aggregate failures,
pending age and service state; it writes a private status file and sends no
email/webhook. The final check was healthy with zero pending/failed jobs and a successful
worker result. This is not external host-down alerting.

The [privacy notice](https://doclifts.runthe.ai/privacy) and versioned upload
acknowledgment remain live. Retention is a manual dry-run/apply control, with no
retention timer. Full account export is not shipped. Signup stays closed.
See [privacy controls](docs/privacy.md) and [activation/recovery](docs/privacy-activation.md).

Private release evidence remains in the VPS-only operations repository.
See [release records](docs/release-0.2.0.md). Owner phone/agent acceptance remains
pending.

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
- Full account export and separately reviewed retention scheduling/log policy
  before public signup; provider processing and external copies retain their own limits.
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
