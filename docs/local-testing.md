# Local Docker testing for Codex Desktop

Owner decision, 2026-10-26: **Docker Desktop on Predator-Doc is the standard
DocLifts test environment for Codex Desktop work.** Run the development and
release test suite here, with Linux containers and PostgreSQL 16. Reserve the
VPS for production builds/deployment, migration and restore rehearsals, and
deployment-specific smoke checks. GitHub branch CI remains required.

The legacy TestDev01 VMware guest is not required. Do not start it for the
DocLifts gate. This test stack is also separate from Open WebUI and the
production Compose stack.

## Commands

Start Docker Desktop, select its local Linux engine, and use PowerShell 7 from
the checkout you intend to test:

```powershell
pwsh -File scripts/local-tests.ps1 up
pwsh -File scripts/local-tests.ps1 gate
pwsh -File scripts/local-tests.ps1 status
pwsh -File scripts/local-tests.ps1 stop
```

`gate` starts the stack if necessary and runs the complete local gate: frozen
dependency install, runtime/browser verification, lint, Svelte check, Drizzle
snapshot check, all server tests, all client tests, build, and all e2e tests.
`CI=1` makes missing browser/build prerequisites fail instead of silently
skipping. A nonzero command stops the gate and propagates failure to PowerShell.

For the normal focused editing loop:

```powershell
pwsh -File scripts/local-tests.ps1 server -TestFilter quick-workouts
pwsh -File scripts/local-tests.ps1 client -TestFilter SetRow
pwsh -File scripts/local-tests.ps1 e2e -TestFilter e2e/csp.e2e.ts
pwsh -File scripts/local-tests.ps1 lint
```

Focused runs do not replace the complete release gate. Markdown-only changes
retain the documented lint-only exception. The e2e command builds first.

## Current source, reusable Linux dependencies

The wrapper snapshots regular tracked files, working-tree edits, and nonignored
new files from **the checkout containing the script**. Deleted tracked files
are omitted. It excludes host dependencies, the host `.git` directory, private environment
files and key/certificate files; the public `.env.example` is included. It does
not read a production environment or mount the host checkout into the runner.

A separate Git bundle supplies HEAD and its history, without host Git
configuration, hooks or credentials. The runner builds a fresh index from that
baseline while retaining the working-tree snapshot. Tests can distinguish
committed catalog files from edits; new files are not silently treated as
committed. This temporary Git directory is recreated for every run.

Every run prints the checkout HEAD and a SHA-256 of the actual source archive.
HEAD alone does not identify uncommitted edits. Source and build output are
replaced in a dedicated Linux volume; `node_modules` and the pnpm store remain
cached. A frozen install reconciles them against the snapshot's lockfile before
any check. This avoids Windows filesystem overhead and stale-source testing.

The shared Compose project is `doclifts-local-test`. A host-wide lock under
`%LOCALAPPDATA%/DocLifts/local-tests` prevents two wrapper invocations from
overwriting source or resetting the same test database concurrently. Run
different branches sequentially. Do not bypass the wrapper with simultaneous
`docker exec` test runs. The wrapper refuses remote Docker contexts and an
explicit `DOCKER_HOST` override.

`Dockerfile.test` uses Node 24.22.1, pnpm 11.3.0 and the same Playwright 1.59.1
image as CI. Update its Node pin together with `.node-version`, package.json,
the lockfile and the production Dockerfile; update its browser tag with the
resolved Playwright version and CI. Version/browser checks fail on drift.

The runner has 2 CPUs, 3 GiB memory and 512 MiB shared memory; PostgreSQL has
1 CPU and 768 MiB memory, including a 384 MiB memory-backed data directory.
The database contains disposable test fixtures and is recreated after a stop,
avoiding Docker Desktop disk-flush latency. These are starting limits, not a promise of a
particular test duration. Both services publish no host ports. Fixture
credentials belong only to this Docker network; no production data is needed.

`stop` preserves containers and dependency caches; database fixtures are lost
and the suite recreates them next time. Avoid pruning Docker volumes as routine cleanup. The earlier
`doclifts-bench-*` and dated audit containers are historical; their cached
source is not evidence that the current checkout passed.

## Security-audit validation is a separate job

This is the ordinary repository test gate, with registry access for dependency
installation and writable test volumes. It is **not** the restricted execution
sandbox required by Cloudflare's security-audit skill. Audit reproduction jobs
must separately satisfy that skill's isolation requirements and use current
source. Starting this stack does not convert a source-only audit lead into a
validated finding.
