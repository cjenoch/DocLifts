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
# successful new dump is on disk, so a broken cron (DB down, disk full, wrong
# password) cannot silently delete history that hasn't been replaced.
#
# Restore:
#   gunzip -c <file>.sql.gz | docker exec -i doclifts-db psql -U doclifts -d doclifts
#
# Outside cron this script sources nothing; it is self-contained so it is
# safe to run from a stripped crontab PATH (binaries are absolute packages
# under /usr/bin and /bin, which cron's default PATH covers).
#
# PERMISSIONS, TEMPORARY FILES AND INTERRUPTION (2026-10-23)
# ----------------------------------------------------------
# The dump is the entire workout history, so nothing this script creates may be
# world-readable, even briefly:
#
#   - `umask 077` is set in the PARENT shell before the first `mkdir`. The
#     previous form was `(umask 077; true)` — a subshell that created nothing,
#     so the mode never applied to anything: directories landed 0755 and the
#     dump was 0644 from the moment it was written until a `chmod 600` ran
#     afterwards. A mode that arrives after the bytes is not a control.
#   - Only the dedicated backup directory is tightened (`chmod 700`), never a
#     parent or anything under it recursively.
#   - The dump is written to a UNIQUE hidden temp file (`mktemp`, 0600 by
#     construction) and moved into place only after it is complete, so a reader
#     never sees a partial file and two runs — a manual one overlapping cron —
#     cannot share a temp path.
#   - A failing or interrupted run removes its temp file and exits non-zero,
#     leaving any earlier dump (including an earlier dump for the same day)
#     exactly as it was.
#
# Env overrides exist for tests; the defaults are production's.
set -euo pipefail

# Container + db identifiers (match docker-compose.yml).
CONTAINER="${DOCLIFTS_DB_CONTAINER:-doclifts-db}"
DB_USER="${DOCLIFTS_DB_USER:-doclifts}"
DB_NAME="${DOCLIFTS_DB_NAME:-doclifts}"

BACKUP_DIR="${DOCLIFTS_BACKUP_DIR:-/srv/backups/doclifts}"
KEEP_DAYS="${DOCLIFTS_KEEP_DAYS:-30}"
DATE=$(date +%Y-%m-%d)
OUT="${BACKUP_DIR}/doclifts-${DATE}.sql.gz"

# Restrictive umask BEFORE any file or directory exists. A umask is a property
# of the process, so it covers the directory, the temp file, and anything a
# later edit to this script adds.
umask 077

mkdir -p "${BACKUP_DIR}"

# Check BEFORE tightening the mode: a root-owned 0700 directory is the failure
# seen in production, and this names it instead of leaving a bare chmod error.
if [[ ! -w "${BACKUP_DIR}" ]]; then
	echo "backup FAILED: ${BACKUP_DIR} is not writable by $(id -un). A root-owned 0700 directory is the usual cause; run the backup as that owner." >&2
	exit 1
fi

chmod 700 "${BACKUP_DIR}"

# Unique per run: `mktemp` creates the file 0600 (and refuses to reuse a name),
# so a concurrent run cannot truncate or promote another run's half-written
# dump. Same directory as OUT, so the promotion below is a rename, not a copy.
TMP=$(mktemp "${BACKUP_DIR}/.doclifts-${DATE}.sql.gz.tmp.XXXXXX")

cleanup() {
	local status=$?
	if [[ -f "${TMP}" ]]; then
		rm -f "${TMP}"
	fi
	# Re-exit with the original status: an EXIT trap must not turn a failure
	# into a success (or a signal into 0) on its way out.
	exit "${status}"
}
trap cleanup EXIT
# Signals: without these bash dies from the signal and no EXIT trap runs, which
# is exactly the "interrupted run" that used to leave a stray .tmp behind.
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# Dump inside the container (peer/trust auth, no password needed) and compress
# on the fly. The redirect goes to the temp file, never to OUT.
if ! docker exec "${CONTAINER}" pg_dump \
	-U "${DB_USER}" -d "${DB_NAME}" \
	--no-owner --no-privileges \
	| gzip >"${TMP}"; then
	echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) backup FAILED: pg_dump/gzip did not complete; ${OUT} not written, nothing pruned" >&2
	exit 1
fi

# A dump that is not a usable archive is not a backup: an empty file, or a
# truncated gzip stream from a full disk, would otherwise be promoted over a
# good dump for the same day. `gzip -t` reads what was just written and fails on
# an incomplete stream.
if [[ ! -s "${TMP}" ]] || ! gzip -t "${TMP}" 2>/dev/null; then
	echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) backup FAILED: dump is empty or its gzip stream is incomplete; ${OUT} not written, nothing pruned" >&2
	exit 1
fi

# Promote only now. mv is atomic within the same filesystem, so a reader sees
# either the previous dump or the new complete one.
mv -f "${TMP}" "${OUT}"

# Prune only after a successful new dump (see header note). `-maxdepth 1` and
# the explicit name patterns keep this to this directory's own files.
find "${BACKUP_DIR}" -maxdepth 1 -name 'doclifts-*.sql.gz' -mtime +"${KEEP_DAYS}" -delete
# Temps orphaned by a SIGKILL (the one case no trap can catch): hidden, in the
# dedicated dir, and never matched by the pattern above — so they would
# otherwise accumulate forever.
find "${BACKUP_DIR}" -maxdepth 1 -name '.doclifts-*.sql.gz.tmp.*' -mtime +1 -delete

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) backup ok: ${OUT} ($(stat -c%s "${OUT}") bytes)"