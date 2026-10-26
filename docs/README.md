# Documentation

Start with the [project README](../README.md) for what DocLifts does and the
[application overview](../APP_DOCS.md) for current behavior. The guides below
describe the implementation; [STATUS.md](../STATUS.md) records deployment evidence
and outstanding acceptance. A feature guide alone does not establish that a live
deployment or owner acceptance was verified.

## Develop and contribute

- [Local development](development.md): first account, environment loading, tests and troubleshooting.
- [Contributing](../CONTRIBUTING.md): contribution terms, commit identity and validation gates.
- [Project rules](../CLAUDE.md): architecture, data invariants and shipping constraints.
- [Test infrastructure](test-refactor.md): coverage boundaries and refactor history.
- [Private-data policy](private-data.md): what belongs outside the repository.

## Use and understand the app

- [First-workout acceptance](first-workout-acceptance.md): phone checklist and remaining owner checks.
- [Program builder](program-builder.md): starter templates, drafts and versioned editing.
- [Machine identity](machine-identity.md): history matching, load conventions and photo blocks.
- [Equipment catalog](catalog.md): shared model data and account-owned machines.
- [Photos](photos.md), [photo safety](photo-safety.md) and [model calls](llm.md): upload, identification and screening.
- [Account exports](data-exports.md): formats, included data and portability limits.
- [MCP access](mcp-alpha.md): agent setup, scopes, tools and pagination.
- [Privacy](privacy.md) and [data lifecycle](data-lifecycle.md): current controls, deletion and remaining work.

## Operate an installation

- [Release runbook](release-0.2.0.md): the continuing release and acceptance log despite its original filename.
- [Public address](public-address.md): origins, trusted headers and the tunnel.
- [Authentication hardening](auth-hardening.md): password admission and MCP request limits.
- [Migrations](migrations.md): migration-chain behavior and recovery constraints.
- [Privacy activation](privacy-activation.md): deletion journal and worker operations.
- [Dependency status](dependencies.md) and [branch protection](branch-protection.md): audit findings and required checks.
- [Current status](../STATUS.md): runtime identity, backups, external monitoring and open acceptance.

## Historical context

[CHANGELOG.md](../CHANGELOG.md) records released changes. Dated handoffs and
closeout reports, `journal/`, `docs/plans/`, and the root `planning_v2_*.md` files
preserve decisions and earlier proposals. Check current guides and source before
following their commands or treating a proposed feature as shipped. Some status
and historical files are omitted from source archives by `.gitattributes`; use a
Git checkout to read them all.
