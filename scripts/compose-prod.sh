#!/usr/bin/env bash
# The only sanctioned way to run production Compose on this host.
#
# WHY THIS EXISTS: production's env file lives at /srv/doclifts/.env, outside
# the repository. The development checkout must never point its own .env at it
# — an earlier symlink did, and every tool run from the checkout (vitest,
# drizzle-kit, tsx) then read production credentials by default. Passing the
# file explicitly with --env-file keeps the two worlds separate and makes the
# production env file an input you can see in the command, not an ambient
# default.
#
# --env-file supplies Compose's interpolation variables AND overrides the
# default ./.env lookup, so the checkout's own .env is never consulted.
#
# Usage:
#   scripts/compose-prod.sh up -d --build --wait web
#   scripts/compose-prod.sh config
#   scripts/compose-prod.sh ps
#   scripts/compose-prod.sh logs -f web
#
# Override the file location with DOCLIFTS_PROD_ENV if it ever moves.
set -euo pipefail

ENV_FILE="${DOCLIFTS_PROD_ENV:-/srv/doclifts/.env}"
if [[ ! -f "$ENV_FILE" ]]; then
	echo "production env file not found: $ENV_FILE" >&2
	exit 1
fi

# The build sha, stamped into the image for /_app/version.json.
#
# Derived HERE rather than required from the operator, because the value is
# knowable only from the checkout and forgetting it produces an image reporting
# the framework's default 'dev' — which still serves, still passes a naive
# check, and silently disables stale-build detection. An export an operator has
# to remember is an export that will be forgotten once.
if [[ -z "${DOCLIFTS_BUILD_SHA:-}" ]]; then
	DOCLIFTS_BUILD_SHA="$(git -C "$(dirname "${BASH_SOURCE[0]}")/.." rev-parse --short HEAD 2>/dev/null || echo unknown)"
fi
export DOCLIFTS_BUILD_SHA
echo "==> building as ${DOCLIFTS_BUILD_SHA}"

# The project name is pinned so this always addresses the production stack and
# cannot collide with a `docker compose` run from the checkout.
exec docker compose -p doclifts --env-file "$ENV_FILE" "$@"
