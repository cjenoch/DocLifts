#!/usr/bin/env bash
# Refuse a production start whose trusted-edge declaration and client-IP header
# disagree — or that never declared an edge at all.
#
# WHY THIS EXISTS
# ---------------
# `CLIENT_IP_HEADER` names the header the sign-in throttle should trust. It does
# not say whether this deployment actually sits behind a proxy that OVERWRITES
# that header. Nothing in the process can tell: a deployment that lost the
# setting looks exactly like one that never needed it, and the app then counts
# sign-in failures against the first X-Forwarded-For value — an address the
# client writes. On the public deployment that turns the throttle into a key an
# attacker chooses, with no visible symptom.
#
# So the edge is DECLARED (DOCLIFTS_TRUSTED_EDGE) and the pair must agree. The
# app enforces the same rule at boot (src/lib/server/client-ip.ts, reached
# through `createAuth` at module load), so the deploy wrapper and the running
# server cannot drift: this check just fails earlier, before a build or a
# container start, with a message that names the missing line.
#
#   DOCLIFTS_TRUSTED_EDGE=cloudflare  ->  CLIENT_IP_HEADER=cf-connecting-ip
#   DOCLIFTS_TRUSTED_EDGE=none        ->  CLIENT_IP_HEADER unset
#   unset                             ->  REFUSED here (see below)
#
# An unset declaration is refused rather than treated as "none" because the
# production stack is publicly reachable through the tunnel: the dangerous
# reading of a missing value is the one that silently trusts a client header.
# Deployments that are not ours set DOCLIFTS_TRUSTED_EDGE=none explicitly, which
# is also what the tailnet-only rollback in docs/public-address.md uses.
#
# Only reads the env file. No docker, no sudo, no side effects.
#
# Usage: scripts/check-trusted-edge.sh <env-file>
# Exit 0 if the pair agrees; 1 (one reason line per problem) if not; 2 on bad
# usage. Every failure names the variable to change.
set -euo pipefail

ENV_FILE="${1:-}"

if [[ -z "$ENV_FILE" || ! -f "$ENV_FILE" ]]; then
	echo "usage: $0 <env-file>  (env file not found: '${ENV_FILE}')" >&2
	exit 2
fi

# The LAST assignment wins, the way a shell reading the file top to bottom would
# resolve it, so a later override is not shadowed by an earlier line.
value_of() {
	sed -nE "s/^[[:space:]]*(export[[:space:]]+)?$1=(.*)$/\2/p" "$ENV_FILE" | tail -n 1
}

# Hand-written env files use both quoted and bare values.
unquote() {
	local v="$1"
	v="${v%\"}"
	v="${v#\"}"
	v="${v%\'}"
	v="${v#\'}"
	printf '%s' "$v"
}

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

RAW_EDGE="$(unquote "$(value_of DOCLIFTS_TRUSTED_EDGE)")"
RAW_HEADER="$(unquote "$(value_of CLIENT_IP_HEADER)")"
# Normalised for comparison only; the raw values are what the messages quote.
edge="$(lower "$RAW_EDGE")"
header="$(lower "$RAW_HEADER")"

if [[ -z "$edge" ]]; then
	echo "trusted-edge check FAILED: $ENV_FILE does not declare DOCLIFTS_TRUSTED_EDGE." >&2
	echo "  Behind the public tunnel: DOCLIFTS_TRUSTED_EDGE=cloudflare with CLIENT_IP_HEADER=cf-connecting-ip" >&2
	echo "  Reached directly (tailnet, or a public-address rollback): DOCLIFTS_TRUSTED_EDGE=none with no CLIENT_IP_HEADER" >&2
	echo "  Undeclared is refused because web is publicly reachable: without the pair the app hashes a client-supplied X-Forwarded-For value into the sign-in throttle." >&2
	exit 1
fi

case "$edge" in
cloudflare)
	if [[ "$header" != cf-connecting-ip ]]; then
		echo "trusted-edge check FAILED: DOCLIFTS_TRUSTED_EDGE=cloudflare requires CLIENT_IP_HEADER=cf-connecting-ip, got '${RAW_HEADER:-<unset>}'." >&2
		exit 1
	fi
	;;
none)
	if [[ -n "$header" ]]; then
		echo "trusted-edge check FAILED: DOCLIFTS_TRUSTED_EDGE=none refuses CLIENT_IP_HEADER='$RAW_HEADER' — nothing overwrites that header, so the client would be trusted." >&2
		exit 1
	fi
	;;
*)
	echo "trusted-edge check FAILED: DOCLIFTS_TRUSTED_EDGE must be 'cloudflare' or 'none', got '$RAW_EDGE'." >&2
	exit 1
	;;
esac

echo "trusted-edge check: DOCLIFTS_TRUSTED_EDGE=${edge}, CLIENT_IP_HEADER=${RAW_HEADER:-<unset>}"