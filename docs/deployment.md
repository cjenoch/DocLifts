# Deploying to production — standing checklist

The order every production deploy follows. The rules behind each step are in
`CLAUDE.md`, "Shipping and production"; each release's own record
(`docs/release-*.md`) holds its specifics. Run every `*-prod.sh` wrapper on the
VPS over SSH.

1. **Gates.** Full local gate and CI green on the release sha; `main` moves only
   through a pull request.
2. **Recovery image.** Tag the running image before building over it. Keep at
   least two previous release images.
3. **Migrations, if any.** Rehearse the full chain on a restore of the nightly
   dump first; then `scripts/migrate-prod.sh`, which takes and verifies its own
   dump.
4. **Deploy.** `scripts/compose-prod.sh up -d --build --wait <service>` for each
   service the release changes (web, the deletion worker, safety). The
   passthrough check runs before `up`.
5. **Smoke.** Containers healthy, the public smoke for the release, and
   `version.json` showing the release sha.
6. **Refresh Vigla's expected container identity (since 2026-11-09).** Vigla, the
   monitor on enochnvps, checks DocLifts' containers by an expected identity. Any
   deploy that recreates a container changes it, and Vigla then alerts on a
   healthy deploy; identical failures alert only once a day, so a stale identity
   can also mask a real failure for up to a day. After every `up` that recreates
   a container:
   - update Vigla's expected identity for each recreated container;
   - confirm one successful watch cycle and a heartbeat delivery.

   This step goes away if Vigla is changed to find containers by their Compose
   project and service labels (`com.docker.compose.project`,
   `com.docker.compose.service`) instead of a container identity.

7. **Record.** The release record and CHANGELOG; "deployed, acceptance pending"
   until the owner signs off any phone check.
