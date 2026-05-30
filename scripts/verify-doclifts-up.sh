#!/usr/bin/env bash
set -euo pipefail

URL="http://127.0.0.1:3000/"
MAX_WAIT_SECONDS="${1:-20}"

# Check that something is listening on :3000 (no sudo required)
if ! ss -ltn '( sport = :3000 )' | grep -q ':3000'; then
	echo "FAIL: nothing is listening on tcp/3000"
	exit 1
fi

deadline=$((SECONDS + MAX_WAIT_SECONDS))
http_code="000"
while (( SECONDS < deadline )); do
	http_code="$(curl -sS -o /tmp/doclifts_verify_home.html -w '%{http_code}' "$URL" || true)"
	if [[ "$http_code" == "200" ]]; then
		break
	fi
	sleep 1
done

if [[ "$http_code" != "200" ]]; then
	echo "FAIL: health check did not return 200 within ${MAX_WAIT_SECONDS}s (last=$http_code)"
	exit 1
fi

# Verify expected app HTML marker, not just any 200.
if ! grep -q "Programs" /tmp/doclifts_verify_home.html; then
	echo "FAIL: home page marker 'Programs' not found in response body"
	exit 1
fi

echo "OK: tcp/3000 listening and $URL returned 200 with expected content marker"
