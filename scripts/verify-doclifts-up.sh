#!/usr/bin/env bash
set -euo pipefail

URL="http://127.0.0.1:3000/"
MAX_WAIT_SECONDS="${1:-20}"

# Poll for readiness. systemctl restart returns before Node binds the port,
# so BOTH the listening check and the HTTP check must live inside the wait
# loop — checking either once up front races startup and fails spuriously.
deadline=$((SECONDS + MAX_WAIT_SECONDS))
http_code="000"
listening=0
while (( SECONDS < deadline )); do
	if ss -ltn '( sport = :3000 )' | grep -q ':3000'; then
		listening=1
		http_code="$(curl -sS -o /tmp/doclifts_verify_home.html -w '%{http_code}' "$URL" || true)"
		if [[ "$http_code" == "200" ]]; then
			break
		fi
	fi
	sleep 1
done

if [[ "$listening" -ne 1 ]]; then
	echo "FAIL: nothing listening on tcp/3000 within ${MAX_WAIT_SECONDS}s"
	exit 1
fi

if [[ "$http_code" != "200" ]]; then
	echo "FAIL: health check did not return 200 within ${MAX_WAIT_SECONDS}s (last=$http_code)"
	exit 1
fi

if ! grep -q "Programs" /tmp/doclifts_verify_home.html; then
	echo "FAIL: home page marker 'Programs' not found in response body"
	exit 1
fi

echo "OK: tcp/3000 listening and $URL returned 200 with expected content marker"
