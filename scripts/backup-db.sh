#!/usr/bin/env bash
#
# Daily pg_dump of the DocLifts production DB (VPS container). Run via cron.
#
# The DB now lives in the `doclifts-db` Postgres container on the VPS. We dump
# through `docker exec` so no host postgres client is needed and credentials
# stay with the container (no .pgpass to rotate). Works unchanged whether the
# script runs as root or the app user.
#
# Writes a gzipped SQL dump to /srv/backups/doclifts/doclifts-YYYY-MM-DD.sql.gz
# and prunes any backup older than 30 days. The prune step runs ONLY after a
# successful new dump, so a broken cron (DB down, disk full, wrong password)
# cannot silently delete history that hasn't been replaced.
#
# Restore:
#   gunzip -c <file>.sql.gz | docker exec -i doclifts-db psql -U doclifts -d doclifts
#
# Outside cron this script sources nothing; it is self-contained so it is
# safe to run from a stripped crontab PATH (binaries are absolute).

set -euo pipefail

# Container + db identifiers (match docker-compose.yml).
CONTAINER=doclifts-db
DB_USER=doclifts
DB_NAME=doclifts

BACKUP_DIR=/srv/backups/doclifts
DATE=$(date +%Y-%m-%d)
OUT="${BACKUP_DIR}/doclifts-${DATE}.sql.gz"
TMP="${OUT}.tmp"

mkdir -p "${BACKUP_DIR}"
# Restrict file modes for anything this script writes: the dump is the entire
# workout history and username/security context must never loosen. umask AFTER
# mkdir so the dir keeps a normal mode but files created inside get 0700/0600.
(umask 077; true)

# Dump inside the container (peer/trust auth, no password needed) and compress
# on the fly. Write to a .tmp first so a partial/failed dump never looks like
# a completed backup.
docker exec "${CONTAINER}" pg_dump \
	-U "${DB_USER}" -d "${DB_NAME}" \
	--no-owner --no-privileges \
	| gzip > "${TMP}"

# Only promote the temp file once the dump+gzip succeeded (set -e guarantees we
# only reach this line on success). mv is atomic on the same filesystem.
mv "${TMP}" "${OUT}"
chmod 600 "${OUT}"

# Prune only after a successful new dump (see header note).
find "${BACKUP_DIR}" -maxdepth 1 -name 'doclifts-*.sql.gz' -mtime +30 -delete

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) backup ok: ${OUT} ($(stat -c%s "${OUT}") bytes)"