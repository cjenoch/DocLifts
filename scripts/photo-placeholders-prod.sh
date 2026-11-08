#!/usr/bin/env bash
# Archive legacy photo placeholder machines in PRODUCTION (one-time cleanup,
# 2026-11-08): a verified backup first, a dry run printed, and the real run
# only on the typed confirmation ARCHIVE, refused if the candidates changed.
#
# What it does: `pnpm photo:placeholders` (scripts/photo-placeholders.ts)
# archives, never deletes, the unmodeled "Photo 2:32 PM" machines that
# `openPhotoBlock` made before c5bb02c and nothing points at any more. An
# archived machine comes back with Restore on its gym page.
#
# Mirrors scripts/catalog-prod.sh, for the same reasons:
#   - Production's env file has no DATABASE_URL; it is built here from
#     POSTGRES_PASSWORD, never required from the environment. It is the ONLY
#     variable the runner receives (the CLI needs no auth secret).
#   - The CLI runs under tsx, a dev dependency, so it runs in the BUILDER image
#     (`--target builder`) on the Compose network.
#   - Dump first, and refuse to archive if the dump fails or does not verify.
#   - The dry run prints a fingerprint of the candidate ids; the apply is given
#     it with --expect and writes nothing if the candidates differ.
#
# It runs under the production rules in CLAUDE.md ("Shipping and production").
#
# Usage (from the deploy checkout on the VPS, over SSH):
#   scripts/photo-placeholders-prod.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
ENV_FILE="${DOCLIFTS_PROD_ENV:-/srv/doclifts/.env}"
BACKUP_DIR="${DOCLIFTS_BACKUP_DIR:-/srv/doclifts/backups}"

if [[ $# -ne 0 ]]; then
	echo "Usage: scripts/photo-placeholders-prod.sh (no arguments)" >&2
	exit 2
fi
cd "$REPO_ROOT"
if [[ ! -f "$ENV_FILE" ]]; then
	echo "production env file not found: $ENV_FILE" >&2
	exit 1
fi

DB_CONTAINER="${DOCLIFTS_DB_CONTAINER:-doclifts-db}"
DB_USER="${DOCLIFTS_DB_USER:-doclifts}"
DB_NAME="${DOCLIFTS_DB_NAME:-doclifts}"
DB_HOST="${DOCLIFTS_DB_HOST:-db}"

# ---------------------------------------------------------------- backup ----
# Exactly catalog-prod.sh's dump handling: nothing is created before
# `umask 077`, the dump lands in a hidden 0600 temp and is moved into its final
# name only after `pg_restore --list` has verified it.
umask 077
mkdir -p "$BACKUP_DIR"
if [[ ! -w "$BACKUP_DIR" ]]; then
	echo "$BACKUP_DIR is not writable by $(id -un) — the pre-archive dump cannot be written. A root-owned 0700 directory is the usual cause; run this wrapper as that owner (sudo)." >&2
	exit 1
fi
chmod 700 "$BACKUP_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP_PATH="${BACKUP_DIR}/preplaceholders-${STAMP}.dump"
TMP_DUMP="$(mktemp "${BACKUP_DIR}/.preplaceholders-${STAMP}.dump.tmp.XXXXXX")"

cleanup() {
	local status=$?
	if [[ -f "$TMP_DUMP" ]]; then
		rm -f "$TMP_DUMP"
	fi
	exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

echo "==> dumping ${DB_NAME} to ${DUMP_PATH}"
if ! docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc >"$TMP_DUMP"; then
	echo "pre-archive dump FAILED — refusing to archive" >&2
	exit 1
fi
if [[ ! -s "$TMP_DUMP" ]]; then
	echo "pre-archive dump is empty — refusing to archive" >&2
	exit 1
fi
if ! docker run --rm -v "${BACKUP_DIR}:/dumps:ro" postgres:16 \
	pg_restore --list "/dumps/$(basename "$TMP_DUMP")" >/dev/null 2>&1; then
	echo "pre-archive dump failed verification — refusing to archive" >&2
	exit 1
fi
mv -f "$TMP_DUMP" "$DUMP_PATH"
echo "==> dump verified ($(du -h "$DUMP_PATH" | cut -f1))"
find "${BACKUP_DIR}" -maxdepth 1 -name '.preplaceholders-*.dump.tmp.*' -mtime +1 -delete

# ------------------------------------------------------------- environment ----
set -a
# shellcheck disable=SC1090
source <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE")
set +a
if [[ -z "${POSTGRES_PASSWORD:-}" ]]; then
	echo "POSTGRES_PASSWORD not set in $ENV_FILE — cannot build DATABASE_URL" >&2
	exit 1
fi
export DATABASE_URL="postgresql://${DB_USER}:${POSTGRES_PASSWORD}@${DB_HOST}:5432/${DB_NAME}"

echo "==> building runner image"
docker build --target builder -t doclifts-migrations:local .

run_cli() {
	docker run --rm --network doclifts_default -e DATABASE_URL \
		doclifts-migrations:local pnpm photo:placeholders "$@"
}

# ---------------------------------------------------------------- dry run ----
echo "==> dry run: pnpm photo:placeholders"
if ! DRY_RUN="$(run_cli)"; then
	printf '%s\n' "$DRY_RUN"
	echo "dry run FAILED (see above) — nothing was written" >&2
	exit 1
fi
printf '%s\n' "$DRY_RUN"

TOTALS="$(printf '%s\n' "$DRY_RUN" | grep -E '^totals: ' || true)"
FINGERPRINT="$(printf '%s\n' "$DRY_RUN" | sed -n 's/^fingerprint: \([0-9a-f]\{64\}\)$/\1/p')"
if [[ -z "$TOTALS" || -z "$FINGERPRINT" || "$(printf '%s\n' "$FINGERPRINT" | wc -l)" -ne 1 ]]; then
	echo "dry run printed no totals or no single fingerprint — refusing to archive" >&2
	exit 1
fi
if [[ "$TOTALS" == *" machines 0 "* ]]; then
	echo "Nothing to archive. Done."
	exit 0
fi

# ------------------------------------------------------------ confirmation ----
# A whole-line prompt, as in catalog-prod.sh: an automated runner reading
# output line by line waits forever for a `read -p` prompt.
echo
echo "Dry run: ${TOTALS#totals: }"
echo "Archive exactly these machines in ${DB_NAME}? Type ARCHIVE to continue:"
answer=""
read -r answer || true
if [[ "$answer" != "ARCHIVE" ]]; then
	echo "not confirmed — nothing was written" >&2
	exit 1
fi

echo "==> archiving (refused if the candidates differ from the dry run)"
run_cli --apply --expect "$FINGERPRINT"

cat <<EOF

Done. A second run of this script must report machines 0.
An archived machine comes back with Restore on its gym page. To undo the whole
run from the dump taken above:
  docker exec -i ${DB_CONTAINER} pg_restore --clean --if-exists --no-owner --no-privileges \\
    -U ${DB_USER} -d ${DB_NAME} < ${DUMP_PATH}
(a full restore: it also undoes everything written since the dump).
EOF
