#!/bin/sh
# Install Kybern on a headless machine: the daemon (kybernd) and the kybern CLI
# for pairing and administration over SSH. No desktop, Node or pnpm is
# involved. Binaries land in ~/.cargo/bin; rerun this to upgrade in place.
#
#   curl --proto '=https' --tlsv1.2 -LsSf \
#     https://github.com/Tresnanda/kybern/releases/latest/download/kybern-remote-install.sh | sh
#
#   ... | sh -s -- --service              also install and start a systemd user service (Linux)
#   ... | sh -s -- --version 0.2.0        pin a release instead of latest
#   ... | sh -s -- --port 4173 --bind 127.0.0.1   listener used by the service (defaults shown)
#
# The service keeps the daemon on loopback; expose it with Tailscale Serve, an
# SSH tunnel or a reverse proxy as described in docs/remote-environments.md,
# then run `kybern pair` to create an invitation for your desktop.
set -eu

REPO="${KYBERN_REPO:-Tresnanda/kybern}"
VERSION="${KYBERN_VERSION:-latest}"
SERVICE=0
PORT=4173
BIND=127.0.0.1

while [ $# -gt 0 ]; do
  case "$1" in
    --service) SERVICE=1 ;;
    --version) VERSION="$2"; shift ;;
    --version=*) VERSION="${1#--version=}" ;;
    --port) PORT="$2"; shift ;;
    --port=*) PORT="${1#--port=}" ;;
    --bind) BIND="$2"; shift ;;
    --bind=*) BIND="${1#--bind=}" ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

case "$(uname -s)" in
  Linux|Darwin) ;;
  *) echo "this installer supports Linux and macOS; on Windows run kybern-installer.ps1 from the release page" >&2; exit 1 ;;
esac
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }

if [ "$VERSION" = "latest" ]; then
  BASE="https://github.com/$REPO/releases/latest/download"
else
  BASE="https://github.com/$REPO/releases/download/v${VERSION#v}"
fi

echo "==> installing kybernd and kybern ($VERSION)"
curl --proto '=https' --tlsv1.2 -LsSf "$BASE/kybern-installer.sh" | sh

BIN="$HOME/.cargo/bin"
if ! command -v kybernd >/dev/null 2>&1; then
  echo "==> add $BIN to PATH, or open a new shell, before running kybernd"
fi

if [ "$SERVICE" = "1" ]; then
  if [ "$(uname -s)" != "Linux" ] || ! command -v systemctl >/dev/null 2>&1; then
    echo "==> --service needs systemd; on this machine start the daemon another way (launchd, tmux, a process manager)" >&2
    exit 1
  fi
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/kybernd.service" <<UNIT
[Unit]
Description=Kybern agent daemon

[Service]
ExecStart=%h/.cargo/bin/kybernd --bind $BIND --port $PORT
WorkingDirectory=%h
Environment="PATH=%h/.cargo/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin"
Restart=on-failure
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=30

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable kybernd >/dev/null 2>&1
  # Restart rather than start, so a service already running an older binary
  # picks up the one just installed.
  systemctl --user restart kybernd
  echo "==> kybernd is running as a user service on $BIND:$PORT"
  if command -v loginctl >/dev/null 2>&1 && ! loginctl show-user "$USER" 2>/dev/null | grep -q '^Linger=yes'; then
    echo "==> keep it running after logout and reboot:  sudo loginctl enable-linger $USER"
  fi
  echo "==> agent CLIs (claude, codex, ...) must be on the service PATH; edit $UNIT_DIR/kybernd.service if they live elsewhere"
fi

cat <<NEXT

Next steps
  1. Install and sign in to the coding-agent CLIs this machine will run.
  2. Make the daemon reachable (Tailscale Serve, SSH tunnel or a reverse proxy).
  3. Run \`kybern pair\` here and paste the invitation into
     Switch environment -> Add environment on your desktop.
  Upgrade later with \`kybernd-update\` (and \`kybern-update\`).
NEXT
