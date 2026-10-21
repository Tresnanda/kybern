#!/usr/bin/env bash
# Scratch daemon + desktop Vite frontend for motion checks.
#   scratch.sh up     start the daemon (fake Claude driver) and Vite
#   scratch.sh down   stop both and delete the scratch data
# Never touches ~/.kybern. Override PORT/VITE_PORT/DATA/KYBERND/KYBERN_CLI as needed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DESKTOP="$(cd "$HERE/../.." && pwd)"
PORT="${PORT:-4368}"
VITE_PORT="${VITE_PORT:-5368}"
DATA="${DATA:-/tmp/kybern-motion-scratch}"
KYBERND="${KYBERND:-/Applications/kybern.app/Contents/MacOS/kybernd}"

case "${1:-up}" in
  up)
    mkdir -p "$DATA"
    # Point the Claude provider at the offline fixture driver.
    python3 - "$DATA" "$HERE/fake-claude-driver.py" <<'PY'
import json, sys, pathlib
data, driver = pathlib.Path(sys.argv[1]), sys.argv[2]
p = data / "settings.json"
s = json.loads(p.read_text()) if p.exists() else {}
s.setdefault("providers", {})["claude-code"] = {"binary": driver}
p.write_text(json.dumps(s))
PY
    nohup "$KYBERND" --data-dir "$DATA" --port "$PORT" >"$DATA/daemon.log" 2>&1 &
    echo $! >"$DATA/daemon.pid"
    for _ in $(seq 1 50); do [ -f "$DATA/daemon.token" ] && break; sleep 0.2; done
    (cd "$DESKTOP" && env -u NAPI_RS_NATIVE_LIBRARY_PATH nohup pnpm exec vite --port "$VITE_PORT" --strictPort >"$DATA/vite.log" 2>&1 & echo $! >"$DATA/vite.pid")
    echo "daemon ws://127.0.0.1:$PORT/ws  app http://127.0.0.1:$VITE_PORT/?url=ws%3A%2F%2F127.0.0.1%3A$PORT%2Fws&token=$(cat "$DATA/daemon.token")"
    ;;
  down)
    for f in vite daemon; do
      [ -f "$DATA/$f.pid" ] && kill "$(cat "$DATA/$f.pid")" 2>/dev/null || true
    done
    pkill -f "vite --port $VITE_PORT" 2>/dev/null || true
    sleep 1
    case "$DATA" in /tmp/kybern-motion-scratch*|*/motion-*) rm -rf "$DATA" ;; *) echo "refusing to delete $DATA" ;; esac
    ;;
esac
