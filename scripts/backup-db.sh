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
#         (set PGPASSWORD or use ~/.pgpass for the restore too).
#
# Credentials: reads PGPASSWORD from ~/.pgpass (the standard libpq path) or
# from the environment. The earlier inline `PGPASSWORD=dev` worked because
# Postgres is bound to 127.0.0.1 (see docker-compose.yml) and this is a
# single-user setup, but committing a working credential to a public repo
# is a footgun if Postgres ever moves off-localhost. Rotate before exposing
# port 5432 to any other interface.
#
# Set up once:
#   echo 'localhost:5432:doclifts:doclifts:dev' >> ~/.pgpass
#   chmod 600 ~/.pgpass

set -euo pipefail

# Cron has a stripped PATH; include the standard binary locations explicitly.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Restrict file modes for any new file this script creates (0600 instead of
# the default 0644). The dump contains the entire workout history — fine on
# a single-user box, not fine if $HOME ever becomes group/world-readable.
umask 077

BACKUP_DIR="${HOME}/backups/doclifts"
DATE=$(date +%Y-%m-%d)
OUT="${BACKUP_DIR}/doclifts-${DATE}.sql.gz"
TMP="${OUT}.tmp"

mkdir -p "${BACKUP_DIR}"

# pg_dump reads ~/.pgpass automatically when PGPASSWORD is unset. Allow an
# inline override for ad-hoc invocations, but never commit the literal.
pg_dump \
	-h localhost -p 5432 -U doclifts -d doclifts \
	--no-owner --no-privileges \
	| gzip > "${TMP}"

mv "${TMP}" "${OUT}"
# umask 077 above already gave us 0600 on the temp file; this is belt-and-
# suspenders in case the umask is ever inherited differently.
chmod 600 "${OUT}"

find "${BACKUP_DIR}" -maxdepth 1 -name 'doclifts-*.sql.gz' -mtime +30 -delete

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) backup ok: ${OUT} ($(stat -c%s "${OUT}") bytes)"
