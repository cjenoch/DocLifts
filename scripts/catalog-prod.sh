#!/usr/bin/env bash
# Import an equipment catalog snapshot into PRODUCTION, with a verified backup
# taken first, a dry run printed, and the real run only on confirmation.
#
# Mirrors scripts/migrate-prod.sh, for the same reasons:
#   - Production's env file has no DATABASE_URL; it is built here from
#     POSTGRES_PASSWORD, never required from the environment.
#   - The importer runs under tsx, a dev dependency, so it runs in the BUILDER
#     image (`--target builder`), on the Compose network, as user-prod.sh does.
#   - Dump first, and refuse to import if the dump fails or does not verify.
#
# What the import does (docs/catalog.md): upserts GLOBAL equipment_models rows
# (owner_user_id IS NULL) keyed on (manufacturer, code), or
# (manufacturer, product_line, name) for codeless rows. It never touches a row
# a user owns. Any row it cannot map aborts the run with nothing written.
#
# It runs under the production rules in CLAUDE.md ("Shipping and production").
#
# Usage (from the deploy checkout on the VPS, over SSH):
#   scripts/catalog-prod.sh data/catalog/equipment_models_seed_2026-09-30.csv
#   scripts/catalog-prod.sh /absolute/path/outside/the/repo/snapshot.csv
#   scripts/catalog-prod.sh "$DOCLIFTS_DATA_DIR/catalog/snapshots/<name>.csv"
#     (a private snapshot; your shell expands the setting before sudo drops
#     the environment; docs/private-data.md)
#
# The CSV is either (scripts/catalog-csv-path.sh has the rules):
#   - a path RELATIVE to the repository root, naming a COMMITTED file; the
#     importer reads it from inside the image, where the checkout is copied to
#     /app. The public snapshots in data/catalog/ are passed this way; or
#   - an ABSOLUTE path to a readable file OUTSIDE the repository, such as a
#     private snapshot kept on the VPS. It is bind-mounted read-only into the
#     import container at /import/catalog.csv and never enters the image.
# A path inside the repository that is not committed, or a missing, unreadable
# or empty file, is refused before anything else runs.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=scripts/catalog-csv-path.sh
source "${REPO_ROOT}/scripts/catalog-csv-path.sh"

ENV_FILE="${DOCLIFTS_PROD_ENV:-/srv/doclifts/.env}"
BACKUP_DIR="${DOCLIFTS_BACKUP_DIR:-/srv/doclifts/backups}"

if [[ $# -ne 1 ]]; then
	echo "Usage: scripts/catalog-prod.sh <committed csv, relative to the repo root | absolute path to a csv outside the repo>" >&2
	exit 2
fi
status=0
resolve_catalog_csv "$1" "$REPO_ROOT" || status=$?
if [[ $status -ne 0 ]]; then
	exit "$status"
fi
CSV="$CATALOG_CSV_ARG"
MOUNT_ARGS=()
CSV_SHA256=""
if [[ -n "$CATALOG_CSV_MOUNT" ]]; then
	MOUNT_ARGS=(-v "${CATALOG_CSV_MOUNT}:${CATALOG_CSV_CONTAINER_PATH}:ro")
	# The dry run and the import read the same host file; this proves it did
	# not change in between (the image pins a repository file by itself).
	CSV_SHA256="$(sha256sum "$CATALOG_CSV_MOUNT" | cut -d' ' -f1)"
	echo "==> CSV outside the repository: ${CATALOG_CSV_MOUNT} (sha256 ${CSV_SHA256}), mounted read-only at ${CSV}"
else
	echo "==> CSV committed in the repository: ${CSV}"
fi
# The relative CSV path and the image build below are both read from the
# repository root, wherever this was started from.
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
# The dump is a full copy of production, so nothing it creates may be readable
# by another user, even briefly. This mirrors migrate-prod.sh exactly
# (2026-10-23/24); the deviation this fixes: the dump used to be redirected
# straight into its final `precatalog-*.dump` name and chmod'ed afterwards, so
# between those two statements the file sat at the ambient umask (0644) and an
# interrupted or SIGKILLed run left it that way permanently. Nothing here may
# create a file before `umask 077`.
umask 077
mkdir -p "$BACKUP_DIR"

# A root-owned 0700 directory is the failure seen in production; name it rather
# than leave a bare chmod error. Same check as migrate-prod.sh, on the same
# default directory (/srv/doclifts/backups), so behaviour does not differ
# between the two wrappers.
if [[ ! -w "$BACKUP_DIR" ]]; then
	echo "$BACKUP_DIR is not writable by $(id -un) — the pre-import dump cannot be written. A root-owned 0700 directory is the usual cause; run this wrapper as that owner (sudo)." >&2
	exit 1
fi

chmod 700 "$BACKUP_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP_PATH="${BACKUP_DIR}/precatalog-${STAMP}.dump"
# The dump lands in a unique hidden temp (0600 from mktemp, and umask 077
# above covers a SIGKILL that skips the trap) and is MOVED into its final name
# only after `pg_restore --list` has verified it, so the retained
# `precatalog-*.dump` set never contains a half-written or unverified file.
TMP_DUMP="$(mktemp "${BACKUP_DIR}/.precatalog-${STAMP}.dump.tmp.XXXXXX")"

cleanup() {
	local status=$?
	if [[ -f "$TMP_DUMP" ]]; then
		rm -f "$TMP_DUMP"
	fi
	# Re-exit with the original status: an EXIT trap must not turn a refused
	# import into a successful one on its way out.
	exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

echo "==> dumping ${DB_NAME} to ${DUMP_PATH}"
if ! docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc >"$TMP_DUMP"; then
	echo "pre-import dump FAILED — refusing to import" >&2
	exit 1
fi
# An empty or truncated dump is not a backup. pg_dump writes a valid file or
# fails, but a redirect to a full disk produces a short one; check it.
if [[ ! -s "$TMP_DUMP" ]]; then
	echo "pre-import dump is empty — refusing to import" >&2
	exit 1
fi
# Verify against the temp name, so an unverified file never appears under a
# `precatalog-*.dump` name.
if ! docker run --rm -v "${BACKUP_DIR}:/dumps:ro" postgres:16 \
	pg_restore --list "/dumps/$(basename "$TMP_DUMP")" >/dev/null 2>&1; then
	echo "pre-import dump failed verification — refusing to import" >&2
	exit 1
fi

# Promote only a verified dump. mv within the directory is atomic, so a reader
# sees either the previous state or the complete verified file.
mv -f "$TMP_DUMP" "$DUMP_PATH"
echo "==> dump verified ($(du -h "$DUMP_PATH" | cut -f1))"

# Hidden temps a SIGKILL left behind are not dumps and are never in any list
# above; clear them once they are a day old. They were created at 0600, so the
# abandoned file is never world-readable either.
find "${BACKUP_DIR}" -maxdepth 1 -name '.precatalog-*.dump.tmp.*' -mtime +1 -delete

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

run_import() {
	docker run --rm --network doclifts_default \
		-e DATABASE_URL \
		"${MOUNT_ARGS[@]}" \
		doclifts-migrations:local pnpm catalog:import "$CSV" "$@"
}

# ---------------------------------------------------------------- dry run ----
echo "==> dry run: pnpm catalog:import $CSV --dry-run"
if ! run_import --dry-run; then
	echo "dry run REFUSED the file (see above) — nothing was written; not importing" >&2
	exit 1
fi

# ------------------------------------------------------------ confirmation ----
# The prompt is a whole line. `read -p` prints it with no newline, and an
# automated runner reading output line by line waited forever for it
# (2026-10-02).
echo
echo "Apply this import to ${DB_NAME}? Type IMPORT to continue:"
answer=""
read -r answer || true
if [[ "$answer" != "IMPORT" ]]; then
	echo "not confirmed — nothing was written" >&2
	exit 1
fi
if [[ -n "$CSV_SHA256" && "$(sha256sum "$CATALOG_CSV_MOUNT" | cut -d' ' -f1)" != "$CSV_SHA256" ]]; then
	echo "the CSV changed since the dry run — nothing was written; run again" >&2
	exit 1
fi

echo "==> importing"
run_import

cat <<EOF

Done. Verify:
  docker exec ${DB_CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -Atc \\
    "select count(*) from equipment_models where owner_user_id is null"
A second run of this script must report 0 inserted and 0 updated.

Rollback is a documented manual step, not automatic. The import only inserts
and updates GLOBAL rows, so the narrow undo is:
  delete from equipment_models where owner_user_id is null and catalog_snapshot = '<date>'
    and id not in (select equipment_model_id from gym_equipment where equipment_model_id is not null)
    and id not in (select equipment_model_id from exercise_equipment_map);
or, for a full restore, the dump taken above:
  docker exec -i ${DB_CONTAINER} pg_restore --clean --if-exists --no-owner --no-privileges \\
    -U ${DB_USER} -d ${DB_NAME} < ${DUMP_PATH}
EOF
