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

# The project name is pinned so this always addresses the production stack and
# cannot collide with a `docker compose` run from the checkout.
exec docker compose -p doclifts --env-file "$ENV_FILE" "$@"
