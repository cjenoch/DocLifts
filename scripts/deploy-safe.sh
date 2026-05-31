#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/home/chris/code/DocLifts"
SERVICE="doclifts.service"
VERIFY_SCRIPT="$APP_DIR/scripts/verify-doclifts-up.sh"
VERIFY_WAIT="${1:-30}"
RELEASES_DIR="$APP_DIR/releases"
CURRENT_LINK="$RELEASES_DIR/current"
PREVIOUS_LINK="$RELEASES_DIR/previous"
RELEASE_ID="$(date +'%Y%m%d-%H%M%S')"
NEW_RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
NEW_BUILD_DIR="$NEW_RELEASE_DIR/build"
KEEP_RELEASES="${DOCLIFTS_KEEP_RELEASES:-5}"
BACKUPS_DIR="$APP_DIR/backups/predeploy"
KEEP_DUMPS="${DOCLIFTS_KEEP_DUMPS:-14}"
MIGRATED=0

mkdir -p "$RELEASES_DIR"
cd "$APP_DIR"

read_database_url() {
	if [[ -n "${DATABASE_URL:-}" ]]; then
		echo "$DATABASE_URL"
		return 0
	fi

	if [[ ! -f "$APP_DIR/.env" ]]; then
		echo ""
		return 0
	fi

	local raw
	raw="$(grep -E '^DATABASE_URL=' "$APP_DIR/.env" | tail -n 1 | cut -d'=' -f2- || true)"
	# Trim optional surrounding quotes from .env style values.
	raw="${raw%\"}"
	raw="${raw#\"}"
	echo "$raw"
}

DATABASE_URL_VALUE="$(read_database_url)"
if [[ -z "$DATABASE_URL_VALUE" ]]; then
	echo "DATABASE_URL is required (env or $APP_DIR/.env)"
	exit 1
fi

PREDEPLOY_DUMP=""

rollback_to_previous() {
	if [[ "${MIGRATED:-0}" == "1" ]]; then
		if [[ -z "${PREDEPLOY_DUMP:-}" || ! -f "$PREDEPLOY_DUMP" ]]; then
			echo "Rollback failed: expected pre-migrate dump not found"
			return 1
		fi

		echo "Rollback: restoring pre-migrate database dump $PREDEPLOY_DUMP"
		if ! pg_restore \
			--clean \
			--if-exists \
			--no-owner \
			--no-privileges \
			--dbname "$DATABASE_URL_VALUE" \
			"$PREDEPLOY_DUMP"; then
			echo "Rollback failed: database restore failed"
			return 1
		fi
	fi

	if [[ -z "${OLD_CURRENT_TARGET:-}" ]]; then
		echo "Rollback unavailable: no previous release target recorded"
		return 1
	fi

	echo "Rollback: repoint current -> $OLD_CURRENT_TARGET"
	ln -sfn "$OLD_CURRENT_TARGET" "$CURRENT_LINK.next"
	mv -Tf "$CURRENT_LINK.next" "$CURRENT_LINK"

	echo "Rollback: restarting service"
	if ! sudo -n systemctl restart "$SERVICE"; then
		echo "Rollback failed: sudo restart requires non-interactive privileges (configure NOPASSWD for systemctl)"
		return 1
	fi
	if ! sudo -n systemctl is-active --quiet "$SERVICE"; then
		echo "Rollback failed: service is not active after restart"
		return 1
	fi
	if ! bash "$VERIFY_SCRIPT" "$VERIFY_WAIT"; then
		echo "Rollback failed: readiness check failed"
		return 1
	fi
}

if [[ -L "$CURRENT_LINK" ]]; then
	OLD_CURRENT_TARGET="$(readlink -f "$CURRENT_LINK")"
else
	OLD_CURRENT_TARGET=""
fi

echo "[1/9] Build"
pnpm build

# SvelteKit adapter-node always emits ./build; copy that immutable artifact
# into a versioned release path for atomic runtime switching.
mkdir -p "$NEW_RELEASE_DIR"
cp -a "$APP_DIR/build" "$NEW_BUILD_DIR"

mkdir -p "$BACKUPS_DIR"

echo "[2/9] Pre-migrate DB dump"
PREDEPLOY_DUMP="$BACKUPS_DIR/predeploy-$RELEASE_ID.dump"
pg_dump \
	"$DATABASE_URL_VALUE" \
	--format=custom \
	--no-owner \
	--no-privileges \
	--file "$PREDEPLOY_DUMP"

echo "[3/9] Migrate"
pnpm db:migrate
MIGRATED=1

if [[ "${DOCLIFTS_DEPLOY_FAIL_AFTER_MIGRATE:-0}" == "1" ]]; then
	echo "Forced failure after migrate (DOCLIFTS_DEPLOY_FAIL_AFTER_MIGRATE=1); invoking rollback"
	if ! rollback_to_previous; then
		echo "Forced failure path: rollback failed"
		exit 92
	fi
	exit 91
fi

echo "[4/9] Atomically swap release symlink"
ln -sfn "$NEW_BUILD_DIR" "$CURRENT_LINK.next"
mv -Tf "$CURRENT_LINK.next" "$CURRENT_LINK"

if [[ -n "$OLD_CURRENT_TARGET" ]]; then
	ln -sfn "$OLD_CURRENT_TARGET" "$PREVIOUS_LINK.next"
	mv -Tf "$PREVIOUS_LINK.next" "$PREVIOUS_LINK"
fi

echo "[5/9] Restart service"
if ! sudo systemctl restart "$SERVICE"; then
	echo "Restart failed; attempting rollback"
	rollback_to_previous
	exit 1
fi

echo "[6/9] Verify service active"
if ! sudo systemctl is-active --quiet "$SERVICE"; then
	echo "Service not active after restart; attempting rollback"
	rollback_to_previous
	exit 1
fi

echo "[7/9] Verify HTTP readiness"
if ! bash "$VERIFY_SCRIPT" "$VERIFY_WAIT"; then
	echo "Readiness failed; attempting rollback"
	rollback_to_previous
	exit 1
fi

echo "[8/9] Prune old releases (keep newest $KEEP_RELEASES)"
find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -name '20*' -printf '%f\n' \
	| sort -r \
	| tail -n +$((KEEP_RELEASES + 1)) \
	| while read -r old_release; do
		rm -rf "$RELEASES_DIR/$old_release"
	done

echo "[9/9] Prune old pre-migrate dumps (keep newest $KEEP_DUMPS)"
find "$BACKUPS_DIR" -mindepth 1 -maxdepth 1 -type f -name 'predeploy-*.dump' -printf '%f\n' \
	| sort -r \
	| tail -n +$((KEEP_DUMPS + 1)) \
	| while read -r old_dump; do
		rm -f "$BACKUPS_DIR/$old_dump"
	done

echo "Deploy complete: build + release copy + dump + migrate + atomic swap + restart + verify"