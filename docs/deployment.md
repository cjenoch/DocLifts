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
   Compose service the release changes (for example, web or safety). The
   passthrough check runs before `up`. The deletion worker is separately
   scheduled: when its code changes, rebuild and pin its immutable image,
   verify a dry run and a scheduled run, and confirm its timer is active; see
   [privacy activation](privacy-activation.md) and the release record.
5. **Smoke.** Containers healthy, the public smoke for the release, and
   `version.json` showing the release sha.
6. **Confirm Vigla saw the deploy.** Vigla, the monitor on enochnvps, currently
   watches the Node runtime in DocLifts' web container, found by Compose labels
   (`com.docker.compose.project=doclifts`, `com.docker.compose.service=web`), so a normal
   container replacement needs no change to it (since 2026-11-09). A missing or
   ambiguous match still fails and alerts. Identical failures repeat at most once a
   day; changed failures alert immediately, and the independent heartbeat monitor
   remains active. After every deploy, confirm one successful watch cycle and a
   heartbeat delivery rather than waiting for an alert.

7. **Record.** The release record and CHANGELOG; "deployed, acceptance pending"
   until the owner signs off any phone check.
