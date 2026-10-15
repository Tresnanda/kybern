#!/bin/sh
# real-gpuix.sh <out.png> [theme] — run GPUIX (no automation pipe) on the scratch data and capture its real window.
# Env: KYBERN_WINDOW_SIZE (default 1440x900). Uses only this checkout's scratch dirs.
OUT=$1; THEME=${2:-dark}
cd "$(dirname "$0")/.."
S=$(bun -e "import {SCRATCH} from './visual/fixture.ts'; console.log(SCRATCH)")
[ -n "$S" ] || exit 1
GPUIX_BACKGROUND=1 KYBERN_OPAQUE=1 KYBERN_REDUCED_MOTION=1 KYBERN_APPEARANCE=$THEME KYBERN_WINDOW_SIZE=${KYBERN_WINDOW_SIZE:-1440x900} KYBERN_DATA_DIR=$S/data KYBERN_CLIENT_CONFIG_DIR=$S/client KYBERN_GPUIX_CREDENTIALS_DIR=$S/credentials bun src/main.tsx >/dev/null 2>&1 </dev/null &
PID=$!
sleep ${REAL_WAIT:-9}
ID=$(swift visual/window-id.swift $PID) && screencapture -x -o -l "$ID" "$OUT"
kill $PID
