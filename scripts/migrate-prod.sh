#!/usr/bin/env bash
# Run pending Drizzle migrations against PRODUCTION, with a verified backup
# taken first.
#
# WHY THIS IS A SCRIPT AND NOT A README COMMAND:
#   1. Production's env file has no DATABASE_URL. It carries POSTGRES_PASSWORD
#      and the app's public settings; the web service builds DATABASE_URL from
#      them in docker-compose.yml. The README used to tell operators that the
#      env file "must carry DATABASE_URL" for migration commands, which was
#      stale — and the workaround in practice was hand-exporting the variable,
#      which is how a stale one ended up in a shell. This script constructs the
#      URL from the env file so no hand-exported DATABASE_URL is ever required.
#   2. deploy-safe.sh used to take a pre-migrate dump automatically. Deleting
#      the systemd path did not delete the dump, so it lives here.
#
# ORDER MATTERS: dump first, and refuse to migrate if the dump fails. A
# migration that runs without a verified backup is not recoverable by hand.
#
# Usage:
#   scripts/migrate-prod.sh              # apply pending migrations
#   DOCLIFTS_PROD_ENV=/path/.env scripts/migrate-prod.sh
set -euo pipefail

ENV_FILE="${DOCLIFTS_PROD_ENV:-/srv/doclifts/.env}"
BACKUP_DIR="${DOCLIFTS_BACKUP_DIR:-/srv/doclifts/backups}"
KEEP_DUMPS="${DOCLIFTS_KEEP_DUMPS:-14}"

if [[ ! -f "$ENV_FILE" ]]; then
	echo "production env file not found: $ENV_FILE" >&2
	exit 1
fi

DB_CONTAINER="${DOCLIFTS_DB_CONTAINER:-doclifts-db}"
DB_USER="${DOCLIFTS_DB_USER:-doclifts}"
DB_NAME="${DOCLIFTS_DB_NAME:-doclifts}"
# Inside the compose network the database answers to its service name. This is
# the same host the `web` service uses.
DB_HOST="${DOCLIFTS_DB_HOST:-db}"

# ---------------------------------------------------------------- backup ----
# Custom format (-Fc): pg_restore can target a single object and is the only
# format that is not a plain SQL script. Compressed, so 14 of them are cheap.
#
# The dump is a full copy of production, so nothing it creates may be readable
# by another user, even briefly (2026-10-23):
#
#   - `umask 077` in the PARENT shell, before the first mkdir. The previous
#     order redirected the dump into its final path and chmod'ed it afterwards:
#     between those two statements the file sat at 0644, and an interrupted run
#     left it that way permanently.
#   - The dump lands in a unique hidden temp file (0600 from `mktemp`) and is
#     MOVED into its final name only after `pg_restore --list` has verified it,
#     so the retained set never contains a half-written or unverified file.
#   - A failing or interrupted run removes its temp and keeps every earlier
#     dump; a SIGKILL is the one case that leaves a hidden temp, which the
#     prune below clears after a day.
umask 077
mkdir -p "$BACKUP_DIR"

# A root-owned 0700 directory is the failure seen in production; name it rather
# than leave a bare chmod error.
if [[ ! -w "$BACKUP_DIR" ]]; then
	echo "$BACKUP_DIR is not writable by $(id -un) — the pre-migrate dump cannot be written. A root-owned 0700 directory is the usual cause; run this wrapper as that owner (sudo)." >&2
	exit 1
fi

chmod 700 "$BACKUP_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP_PATH="${BACKUP_DIR}/predeploy-${STAMP}.dump"
TMP_DUMP="$(mktemp "${BACKUP_DIR}/.predeploy-${STAMP}.dump.tmp.XXXXXX")"

cleanup() {
	local status=$?
	if [[ -f "$TMP_DUMP" ]]; then
		rm -f "$TMP_DUMP"
	fi
	# Re-exit with the original status: an EXIT trap must not turn a refused
	# migration into a successful one on its way out.
	exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

echo "==> dumping ${DB_NAME} to ${DUMP_PATH}"
if ! docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc >"$TMP_DUMP"; then
	echo "pre-migrate dump FAILED — refusing to migrate" >&2
	exit 1
fi

# An empty or truncated dump is not a backup. pg_dump writes a valid file or
# fails, but a redirect to a full disk produces a short one; check it.
if [[ ! -s "$TMP_DUMP" ]]; then
	echo "pre-migrate dump is empty — refusing to migrate" >&2
	exit 1
fi

# Confirm the dump is loadable enough to be trusted: pg_restore --list parses
# the table of contents without touching the database. Run against the temp
# name, so an unverified file never appears under a `predeploy-*.dump` name.
if ! docker run --rm -v "${BACKUP_DIR}:/dumps:ro" postgres:16 \
	pg_restore --list "/dumps/$(basename "$TMP_DUMP")" >/dev/null 2>&1; then
	echo "pre-migrate dump failed verification — refusing to migrate" >&2
	exit 1
fi

# Promote only a verified dump. mv within the directory is atomic, so a reader
# sees either the previous state or the complete verified file.
mv -f "$TMP_DUMP" "$DUMP_PATH"
echo "==> dump verified ($(du -h "$DUMP_PATH" | cut -f1))"

# ------------------------------------------------------------- migrate ----
# DATABASE_URL is built here, never required from the environment.
set -a
# shellcheck disable=SC1090
source <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE")
set +a

if [[ -z "${POSTGRES_PASSWORD:-}" ]]; then
	echo "POSTGRES_PASSWORD not set in $ENV_FILE — cannot build DATABASE_URL" >&2
	exit 1
fi

export DATABASE_URL="postgresql://${DB_USER}:${POSTGRES_PASSWORD}@${DB_HOST}:5432/${DB_NAME}"

echo "==> building migration image"
docker build --target builder -t doclifts-migrations:local .

echo "==> applying migrations to ${DB_NAME}"
# ONLY DATABASE_URL enters the migration process (2026-10-23).
#
# This used to pass the whole production env file with `--env-file`, plus an
# explicit BETTER_AUTH_SECRET. Nothing in the migration reads them:
# `pnpm db:migrate` runs drizzle-kit, which loads drizzle.config.ts (DATABASE_URL,
# and `import 'dotenv/config'`, a no-op because the container has no .env) and the
# schema module (src/lib/server/db/schema.ts — table definitions only, no env
# read). So the passthrough handed the container the S3 keys, the OpenRouter key,
# the auth secret and every other production credential for no reason at all,
# and any future `docker inspect`-style mistake would have reproduced them all.
#
# The dumping steps above already read what they need from the env file in this
# shell; the container gets one variable, named explicitly. Adding a second one
# is a change to argue for here, with the import that reads it.
#
# set -e means a failed migration exits with its status, and the prune below is
# reached only on success.
if ! docker run --rm --network doclifts_default \
	-e DATABASE_URL \
	doclifts-migrations:local pnpm db:migrate; then
	echo "migration FAILED — the pre-migrate dump is retained at ${DUMP_PATH}; fix forward or restore it (see docs/migrations.md)" >&2
	exit 1
fi

# --------------------------------------------------------------- prune ----
# Only after a successful migration, and only newest-first beyond KEEP_DUMPS.
echo "==> pruning to the newest ${KEEP_DUMPS} dumps"
# shellcheck disable=SC2012
ls -1t "${BACKUP_DIR}"/predeploy-*.dump 2>/dev/null | tail -n "+$((KEEP_DUMPS + 1))" | while read -r old; do
	echo "    removing $old"
	rm -f "$old"
done

# Hidden temps a SIGKILL left behind are not dumps and are never in the list
# above; clear them once they are a day old.
find "${BACKUP_DIR}" -maxdepth 1 -name '.predeploy-*.dump.tmp.*' -mtime +1 -delete

cat <<EOF

Done. Rollback is a documented manual step, not automatic:
  docker exec -i ${DB_CONTAINER} pg_restore --clean --if-exists --no-owner --no-privileges \\
    -U ${DB_USER} -d ${DB_NAME} < ${DUMP_PATH}

--clean drops only objects present in the dump, so objects a MIGRATION created
(the auth schema, the ownership columns) survive a restore and need explicit
drops. See docs/migrations.md.
EOF
