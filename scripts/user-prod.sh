#!/usr/bin/env bash
# Run a `pnpm user:*` command against PRODUCTION.
#
# WHY THIS IS A SCRIPT AND NOT A README COMMAND:
#   Same reason migrate-prod.sh exists. Production's env file carries
#   POSTGRES_PASSWORD and the app's settings, not DATABASE_URL — the `web`
#   service builds that inside docker-compose.yml. So the URL is constructed
#   here, and no hand-exported DATABASE_URL is ever required. A stale
#   hand-exported one is how a CLI ends up pointed at the wrong database.
#
# WHY THE BUILDER IMAGE, NOT THE RUNTIME IMAGE:
#   These scripts run under `tsx`, which is a dev dependency. The runtime image
#   ships production dependencies only and has no tsx and no TypeScript
#   sources compiled for it. The builder image (`--target builder`, the same
#   target migrate-prod.sh uses) has both.
#
# THE ONE REQUIRED STEP AFTER MIGRATIONS
#   `pnpm user:bootstrap` is how the 0011 sentinel becomes a real account, and
#   therefore how the existing workouts become visible. Run it after every
#   migration that has applied 0011; it is safe to re-run, and it refuses
#   rather than guessing if the database already has real users.
#
# No backup is taken here, unlike migrate-prod.sh: these commands create or
# update one account row and never touch workout data, so the pre-migrate dump
# that guards the migration step is the right place for that guarantee. The
# dump taken by migrate-prod.sh immediately before is still on disk.
#
# Usage:
#   scripts/user-prod.sh bootstrap --email you@example.com --password-stdin
#
# Prefer --password-stdin. A password given as an argument is visible in the
# process list for the life of the command and is written to shell history,
# which is a poor place to keep a credential that may already have been
# exposed:
#   printf '%s' "$(pass show doclifts)" | scripts/user-prod.sh set-password \
#       --email you@example.com --password-stdin
#   scripts/user-prod.sh create --email you@example.com --password '...' --name "You"
#   scripts/user-prod.sh set-password --email you@example.com --password-stdin
#
# The password is passed on the command line, so it is visible in the process
# list while running. That is acceptable for an operator tool run by hand over
# SSH; it is not acceptable to bake into a script or a CI job.
set -euo pipefail

ENV_FILE="${DOCLIFTS_PROD_ENV:-/srv/doclifts/.env}"

if [[ ! -f "$ENV_FILE" ]]; then
	echo "production env file not found: $ENV_FILE" >&2
	exit 1
fi

if [[ $# -lt 1 ]]; then
	echo "Usage: scripts/user-prod.sh {bootstrap|create|set-password} --email ... --password ..." >&2
	exit 1
fi

COMMAND="$1"
shift

case "$COMMAND" in
bootstrap | create | set-password) ;;
*)
	echo "unknown command '$COMMAND' (expected bootstrap, create, or set-password)" >&2
	exit 1
	;;
esac

DB_USER="${DOCLIFTS_DB_USER:-doclifts}"
DB_NAME="${DOCLIFTS_DB_NAME:-doclifts}"
# Inside the compose network the database answers to its service name.
DB_HOST="${DOCLIFTS_DB_HOST:-db}"

# DATABASE_URL is built here, never required from the environment.
set -a
# shellcheck disable=SC1090
source <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE")
set +a

if [[ -z "${POSTGRES_PASSWORD:-}" ]]; then
	echo "POSTGRES_PASSWORD not set in $ENV_FILE — cannot build DATABASE_URL" >&2
	exit 1
fi

if [[ -z "${BETTER_AUTH_SECRET:-}" ]]; then
	# Not optional. The CLI creates a real credential hash, and Better Auth
	# refuses a short secret. An unclaimed sentinel left behind by a skipped
	# bootstrap is recoverable; a weak secret is not.
	echo "BETTER_AUTH_SECRET not set in $ENV_FILE — refusing to run" >&2
	exit 1
fi

export DATABASE_URL="postgresql://${DB_USER}:${POSTGRES_PASSWORD}@${DB_HOST}:5432/${DB_NAME}"

echo "==> building runner image"
docker build --target builder -t doclifts-migrations:local .

# ONLY the variables the helper actually reads reach its container (2026-10-24).
# This used to pass the WHOLE production env file with `--env-file`, so the S3
# keys, the OpenRouter key, the Resend key and other unrelated credentials
# entered a container that does not need them. The auth secret remains required.
#
# An ALLOWLIST, and specifically NOT the "pass the two secrets" shortcut: the
# CLI builds its own auth instance from process.env outside SvelteKit
# (scripts/user-cli-context.ts -> auth-core.ts), so it needs the same
# non-secret configuration the server runs with. Dropping PUBLIC_ORIGIN,
# DOCLIFTS_OPEN_SIGNUP, DOCLIFTS_RATE_LIMIT_STORAGE, SESSION_EXPIRES_DAYS or
# PASSWORD_MIN_LENGTH would silently fall back to the code defaults, letting
# the CLI enforce a different password policy or origin than the running
# server — exactly the drift users.ts and auth-core.ts exist to prevent.
# Adding a key here is a change to argue for, with the import that reads it.
#
# Bare `-e NAME` passes the value through from this shell's environment (the
# env file was sourced above), so values do not appear in the Docker command
# arguments. Docker administrators can still inspect the container environment.
# Optional keys are passed only when nonempty in the sourced shell environment;
# otherwise the CLI keeps its own default.
RUNNER_ENV_ARGS=(-e DATABASE_URL -e BETTER_AUTH_SECRET)
for key in \
	PUBLIC_ORIGIN \
	DOCLIFTS_OPEN_SIGNUP \
	DOCLIFTS_RATE_LIMIT_STORAGE \
	SESSION_EXPIRES_DAYS \
	PASSWORD_MIN_LENGTH; do
	if [[ -n "${!key:-}" ]]; then
		RUNNER_ENV_ARGS+=(-e "$key")
	fi
done

echo "==> pnpm user:${COMMAND} against ${DB_NAME}"
# exec so the command's exit status is this script's exit status.
# -i so a piped --password-stdin reaches the script inside the container.
# Without it the CLI's stdin guard sees a TTY-ish empty stream and refuses.
docker run --rm -i --network doclifts_default \
	"${RUNNER_ENV_ARGS[@]}" \
	doclifts-migrations:local pnpm "user:${COMMAND}" "$@"

cat <<EOF

Done. Verify by signing in at the public origin with the credentials you just
set. If bootstrap reported "Claimed the 0011 sentinel", the existing workouts
are now visible at /history.
EOF