#!/usr/bin/env bash
#
# Daily pg_dump of the doclifts dev DB. Run via cron.
#
# Writes a gzipped SQL dump to ~/backups/doclifts/doclifts-YYYY-MM-DD.sql.gz
# and prunes any backup older than 30 days. The prune step runs ONLY after a
# successful new dump, so a broken cron (DB down, disk full, wrong password)
# cannot silently delete history that hasn't been replaced.
#
# Restore: gunzip -c <file>.sql.gz | psql -h localhost -U doclifts -d doclifts
#
# Tested manually against the Docker-hosted Postgres 16 instance described in
# docker-compose.yml. The DB password is the same dev password baked into
# that file — this is a personal single-user setup, not a deployable service.

set -euo pipefail

# Cron has a stripped PATH; include the standard binary locations explicitly.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

BACKUP_DIR="${HOME}/backups/doclifts"
DATE=$(date +%Y-%m-%d)
OUT="${BACKUP_DIR}/doclifts-${DATE}.sql.gz"
TMP="${OUT}.tmp"

mkdir -p "${BACKUP_DIR}"

PGPASSWORD=dev pg_dump \
	-h localhost -p 5432 -U doclifts -d doclifts \
	--no-owner --no-privileges \
	| gzip > "${TMP}"

mv "${TMP}" "${OUT}"

find "${BACKUP_DIR}" -maxdepth 1 -name 'doclifts-*.sql.gz' -mtime +30 -delete

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) backup ok: ${OUT} ($(stat -c%s "${OUT}") bytes)"
