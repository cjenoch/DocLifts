#!/bin/sh
# Photo upload timings over the last N days (0.5.3): per stage, the count,
# median, p90 and max in ms, plus how many photo_upload lines carry no timings
# (written before 0.5.3). See docs/photos.md, "Timing each stage".
#
# Usage, on the VPS, from the deploy checkout, as yourself (not under sudo:
# the script asks sudo for the log read only, and node runs as you):
#   scripts/photo-timings-report.sh        # last 7 days
#   scripts/photo-timings-report.sh 14
#
# Read-only: it runs `compose-prod.sh logs` and nothing else. It prints only
# timings and counts; never a photo id, a size or any other field of a line.
#
# PHOTO_TIMINGS_LOG=<file> reads a saved log instead of the container's (and
# is how the test runs this script without production).
set -eu

days="${1:-7}"
case "$days" in
'' | *[!0-9]* | 0)
	echo "usage: $0 [days]   (a whole number of days, at least 1)" >&2
	exit 2
	;;
esac

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

log=$(mktemp)
trap 'rm -f "$log"' EXIT INT TERM

if [ -n "${PHOTO_TIMINGS_LOG:-}" ]; then
	cat -- "$PHOTO_TIMINGS_LOG" >"$log"
else
	# Docker's --since takes a Go duration, which has no "d": days go as hours.
	if [ "$(id -u)" -eq 0 ]; then sudo=''; else sudo='sudo -n'; fi
	$sudo "$here/compose-prod.sh" logs --no-log-prefix --since "$((days * 24))h" web >"$log"
fi

node "$here/photo-timings-report.mjs" "$days" <"$log"
