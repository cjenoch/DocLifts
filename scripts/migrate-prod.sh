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
mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP_PATH="${BACKUP_DIR}/predeploy-${STAMP}.dump"

echo "==> dumping ${DB_NAME} to ${DUMP_PATH}"
if ! docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc >"$DUMP_PATH"; then
	echo "pre-migrate dump FAILED — refusing to migrate" >&2
	rm -f "$DUMP_PATH"
	exit 1
fi

# An empty or truncated dump is not a backup. pg_dump writes a valid file or
# fails, but a redirect to a full disk produces a short one; check it.
if [[ ! -s "$DUMP_PATH" ]]; then
	echo "pre-migrate dump is empty — refusing to migrate" >&2
	rm -f "$DUMP_PATH"
	exit 1
fi
chmod 600 "$DUMP_PATH"

# Confirm the dump is loadable enough to be trusted: pg_restore --list parses
# the table of contents without touching the database.
if ! docker run --rm -v "${BACKUP_DIR}:/dumps:ro" postgres:16 \
	pg_restore --list "/dumps/$(basename "$DUMP_PATH")" >/dev/null 2>&1; then
	echo "pre-migrate dump failed verification — refusing to migrate" >&2
	rm -f "$DUMP_PATH"
	exit 1
fi
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
# exec so the migration's exit status is this script's exit status.
docker run --rm --network doclifts_default \
	-e DATABASE_URL -e BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-}" \
	--env-file "$ENV_FILE" \
	doclifts-migrations:local pnpm db:migrate

# --------------------------------------------------------------- prune ----
# Only after a successful migration, and only newest-first beyond KEEP_DUMPS.
echo "==> pruning to the newest ${KEEP_DUMPS} dumps"
# shellcheck disable=SC2012
ls -1t "${BACKUP_DIR}"/predeploy-*.dump 2>/dev/null | tail -n "+$((KEEP_DUMPS + 1))" | while read -r old; do
	echo "    removing $old"
	rm -f "$old"
done

cat <<EOF

Done. Rollback is a documented manual step, not automatic:
  docker exec -i ${DB_CONTAINER} pg_restore --clean --if-exists --no-owner --no-privileges \\
    -U ${DB_USER} -d ${DB_NAME} < ${DUMP_PATH}

--clean drops only objects present in the dump, so objects a MIGRATION created
(the auth schema, the ownership columns) survive a restore and need explicit
drops. See docs/migrations.md.
EOF
