# DocLifts instructions for Codex

Read `CLAUDE.md` for the project's architecture, test, security and shipping
rules, and `CONTRIBUTING.md` for contribution requirements.

For Codex Desktop work on Predator-Doc, use the local Docker test stack as the
default. From the checkout being changed, run:

```powershell
pwsh -File scripts/local-tests.ps1 gate
```

See `docs/local-testing.md` for startup, focused checks and cache behavior.
The wrapper tests current working-tree content, not an old container snapshot.
Do not start the legacy TestDev01 VMware guest or use the VPS for routine tests.
The VPS retains deployment, migration/restore rehearsal and production smoke
checks; GitHub branch CI remains required. The Markdown-only gate exception in
`CLAUDE.md` still applies. Ordinary test containers are not the restricted
sandbox required for executing security-audit reproductions.
