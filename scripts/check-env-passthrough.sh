#!/usr/bin/env bash
# Refuse a deploy whose env file sets a key that docker-compose.yml never reads.
#
# WHY: compose enumerates the container environment explicitly and does NOT
# forward the env file into the container on its own. A key written to
# /srv/doclifts/.env with no `${KEY...}` reference in docker-compose.yml is
# silently absent from the running process — and every check still passes,
# because the env file looks right. That is how the 0.2.2 deploy ran a
# throttle ceiling of 10 with `LOGIN_MAX_FAILURES=0` in the file.
#
# HOW: every KEY= line in the env file must appear in the compose file as a
# `${KEY}`, `${KEY:-…}`, `${KEY:?…}` or `${KEY-…}` reference. Names, not the
# rendered `compose config`: the rendered output carries values, and some keys
# are consumed only by interpolation (POSTGRES_PASSWORD builds DATABASE_URL and
# never appears under its own name), so a rendered-config comparison would
# both miss names and flag correct ones.
#
# Usage: scripts/check-env-passthrough.sh <env-file> [compose-file]
# Exit 0 if every key is read; 1 (listing each orphan) if not; 2 on bad usage.
set -euo pipefail

ENV_FILE="${1:-}"
COMPOSE_FILE="${2:-$(dirname "${BASH_SOURCE[0]}")/../docker-compose.yml}"

if [[ -z "$ENV_FILE" || ! -f "$ENV_FILE" ]]; then
	echo "usage: $0 <env-file> [compose-file]  (env file not found: '${ENV_FILE}')" >&2
	exit 2
fi
if [[ ! -f "$COMPOSE_FILE" ]]; then
	echo "compose file not found: $COMPOSE_FILE" >&2
	exit 2
fi

# Keys the env file sets: `KEY=...` or `export KEY=...`, ignoring comments.
mapfile -t keys < <(
	sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*/\2/p' "$ENV_FILE" | sort -u
)

# Names the compose file interpolates.
mapfile -t read_names < <(grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*' "$COMPOSE_FILE" | cut -c3- | sort -u)

orphans=()
for key in "${keys[@]}"; do
	found=0
	for name in "${read_names[@]}"; do
		if [[ "$key" == "$name" ]]; then
			found=1
			break
		fi
	done
	if [[ $found -eq 0 ]]; then orphans+=("$key"); fi
done

if (( ${#orphans[@]} )); then
	echo "env passthrough check FAILED: ${#orphans[@]} key(s) in $ENV_FILE are never read by $COMPOSE_FILE:" >&2
	for key in "${orphans[@]}"; do
		echo "  $key  -> add \`$key: \${$key:-<default>}\` under the service's environment:, or remove it from the env file" >&2
	done
	echo "They would be silently absent from the container. Refusing." >&2
	exit 1
fi

echo "env passthrough check: all ${#keys[@]} key(s) in $ENV_FILE are read by $(basename "$COMPOSE_FILE")"
