# DocLifts — current status

Updated October 3, 2026. Current application: **0.16.3 Alpha**, runtime `d56be47`.
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

0.16.3 passed local lint, types, Drizzle checks, build, 901 server tests
(+2 expected skips), 40 component tests and 171 browser tests, then
[exact-head CI](https://github.com/cjenoch/DocLifts/actions/runs/37165497476).
Public test-account checks covered both new readers, pagination, note consent,
refresh/revocation and normal login/history. A backup was restored and checked;
at least two prior images are retained. Private evidence stays in the private
operations repository. See [release records](docs/release-0.2.0.md).

Actual client read success is not a guarantee of complete pagination or correct
training analysis. Other agent clients and owner interpretation review remain
separate acceptance work.

## Next work, not shipped

- Off-host encrypted backup automation and a timed restore drill. Current local
  dumps and rehearsals do not provide redundancy or off-host recovery.
- Measured capacity tests and follow-up on the existing security findings before
  widening Alpha access. Screening does not solve prompt injection.
- Signup/approval gates, beginner onboarding, and simple/advanced UI choices.
- Explicit test/training labels; richer import/export and reviewed notebook
  ingestion. Existing imported history is readable, not a self-service importer.
- Beginner machine guidance and further client compatibility checks.

See [application overview](APP_DOCS.md), [MCP guide](docs/mcp-alpha.md),
[README](README.md) and [changelog](CHANGELOG.md). Historical status and design
notes remain in Git history; they are not current deployment instructions.
