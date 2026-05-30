#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/home/chris/code/DocLifts"
SERVICE="doclifts.service"
VERIFY_SCRIPT="$APP_DIR/scripts/verify-doclifts-up.sh"
VERIFY_WAIT="${1:-30}"

cd "$APP_DIR"

echo "[1/5] Build"
pnpm build

echo "[2/5] Migrate"
pnpm db:migrate

echo "[3/5] Restart service"
sudo systemctl restart "$SERVICE"

echo "[4/5] Verify service active"
sudo systemctl is-active --quiet "$SERVICE"

echo "[5/5] Verify HTTP readiness"
bash "$VERIFY_SCRIPT" "$VERIFY_WAIT"

echo "Deploy complete: build + migrate + restart + verify"
