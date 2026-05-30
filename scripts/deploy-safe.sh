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

mkdir -p "$RELEASES_DIR"
cd "$APP_DIR"

rollback_to_previous() {
	if [[ -z "${OLD_CURRENT_TARGET:-}" ]]; then
		echo "Rollback unavailable: no previous release target recorded"
		return 1
	fi

	echo "Rollback: repoint current -> $OLD_CURRENT_TARGET"
	ln -sfn "$OLD_CURRENT_TARGET" "$CURRENT_LINK.next"
	mv -Tf "$CURRENT_LINK.next" "$CURRENT_LINK"

	echo "Rollback: restarting service"
	sudo systemctl restart "$SERVICE"
	sudo systemctl is-active --quiet "$SERVICE"
	bash "$VERIFY_SCRIPT" "$VERIFY_WAIT"
}

if [[ -L "$CURRENT_LINK" ]]; then
	OLD_CURRENT_TARGET="$(readlink -f "$CURRENT_LINK")"
else
	OLD_CURRENT_TARGET=""
fi

echo "[1/7] Build"
pnpm build

# SvelteKit adapter-node always emits ./build; copy that immutable artifact
# into a versioned release path for atomic runtime switching.
mkdir -p "$NEW_RELEASE_DIR"
cp -a "$APP_DIR/build" "$NEW_BUILD_DIR"

echo "[2/7] Migrate"
pnpm db:migrate

if [[ "${DOCLIFTS_DEPLOY_FAIL_AFTER_MIGRATE:-0}" == "1" ]]; then
	echo "Forced failure after migrate (DOCLIFTS_DEPLOY_FAIL_AFTER_MIGRATE=1)"
	exit 91
fi

echo "[3/7] Atomically swap release symlink"
ln -sfn "$NEW_BUILD_DIR" "$CURRENT_LINK.next"
mv -Tf "$CURRENT_LINK.next" "$CURRENT_LINK"

if [[ -n "$OLD_CURRENT_TARGET" ]]; then
	ln -sfn "$OLD_CURRENT_TARGET" "$PREVIOUS_LINK.next"
	mv -Tf "$PREVIOUS_LINK.next" "$PREVIOUS_LINK"
fi

echo "[4/7] Restart service"
if ! sudo systemctl restart "$SERVICE"; then
	echo "Restart failed; attempting rollback"
	rollback_to_previous
	exit 1
fi

echo "[5/7] Verify service active"
if ! sudo systemctl is-active --quiet "$SERVICE"; then
	echo "Service not active after restart; attempting rollback"
	rollback_to_previous
	exit 1
fi

echo "[6/7] Verify HTTP readiness"
if ! bash "$VERIFY_SCRIPT" "$VERIFY_WAIT"; then
	echo "Readiness failed; attempting rollback"
	rollback_to_previous
	exit 1
fi

echo "[7/7] Prune old releases (keep newest $KEEP_RELEASES)"
find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -name '20*' -printf '%f\n' \
	| sort -r \
	| tail -n +$((KEEP_RELEASES + 1)) \
	| while read -r old_release; do
		rm -rf "$RELEASES_DIR/$old_release"
	done

echo "Deploy complete: build + release copy + migrate + atomic swap + restart + verify"