#!/usr/bin/env bash
set -euo pipefail

# Keep a container-side lock too: an interrupted docker exec can leave its
# child running after the Windows wrapper has released the host lock.
archive="${1:?source archive required}"
shift
[[ "$archive" =~ ^/tmp/doclifts-run-[a-f0-9]+\.tar$ ]]
bundle="${archive%.tar}.bundle"
trap 'rm -f -- "$archive" "$bundle" "$0"' EXIT
exec 9>/tmp/doclifts-test-gate.lock
flock -n 9 || { echo 'Another test process is still running in this container' >&2; exit 1; }
# /work is a dedicated Docker volume, never a host checkout.
cd /work
test -f "$archive"
find /work -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf -- {} +
tar -xf "$archive" -C /work
rm "$archive"
git init -q
git config core.fileMode false
git fetch -q "$bundle" refs/heads/local-test-baseline
git reset -q --mixed FETCH_HEAD
rm "$bundle"

export DATABASE_URL="postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:5432/${PGDATABASE}"
export TEST_DATABASE_URL="$DATABASE_URL"
export BETTER_AUTH_SECRET=doclifts-local-test-only-not-a-real-credential
export CI=1
test "$(node -p 'process.versions.node')" = "$(tr -d '\r\n' < .node-version)"
pnpm install --frozen-lockfile --store-dir /pnpm-store
pnpm exec node --input-type=module -e '
  import { existsSync } from "node:fs";
  import { chromium } from "playwright";
  if (!existsSync(chromium.executablePath())) throw new Error("Rebuild Dockerfile.test: Playwright browser version mismatch");
'

case "${1:-gate}" in
  gate)
    pnpm lint
    pnpm check
    pnpm exec drizzle-kit check
    pnpm test:unit --project server
    pnpm test:unit --project client
    pnpm build
    pnpm test:e2e
    ;;
  lint) pnpm lint ;;
  server) shift; pnpm test:server "$@" ;;
  client) shift; pnpm test:client "$@" ;;
  e2e) shift; pnpm build; pnpm test:e2e "$@" ;;
  *) echo 'Unknown check' >&2; exit 2 ;;
esac
