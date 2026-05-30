#!/usr/bin/env bash
set -euo pipefail

SERVICE="doclifts.service"
OVERRIDE_DIR="/etc/systemd/system/${SERVICE}.d"
OVERRIDE_FILE="${OVERRIDE_DIR}/10-migrate-and-release.conf"

sudo mkdir -p "$OVERRIDE_DIR"

cat <<'EOF' | sudo tee "$OVERRIDE_FILE" >/dev/null
[Service]
# Invariant: any restart/start path must successfully run migrations first.
ExecStartPre=/usr/bin/pnpm --dir /home/chris/code/DocLifts db:migrate

# Run the release selected by deploy-safe's atomic symlink.
ExecStart=
ExecStart=/usr/bin/node /home/chris/code/DocLifts/releases/current
EOF

sudo systemctl daemon-reload
sudo systemctl restart "$SERVICE"
sudo systemctl is-active --quiet "$SERVICE"

echo "Applied override: $OVERRIDE_FILE"
