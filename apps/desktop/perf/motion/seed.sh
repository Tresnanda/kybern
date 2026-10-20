#!/usr/bin/env bash
# Seeds the scratch daemon started by scratch.sh with the scenes the motion probes use.
#   DATA=<scratch dir> ./seed.sh
# Threads (fake offline Claude driver, see fake-claude-driver.py): settled work with tools and
# edits, a long answer (table, code, mermaid), a failed turn, a pending approval, a pending
# question, native subagent + delegation rows, and a turn that keeps streaming.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DATA="${DATA:-/tmp/kybern-motion-scratch}"
KYBERN="${KYBERN_CLI:-/Applications/kybern.app/Contents/MacOS/kybern}"
PROJECT="${PROJECT:-$DATA/project}"
k() { "$KYBERN" --data-dir "$DATA" "$@"; }

mkdir -p "$PROJECT/src"
if [ ! -d "$PROJECT/.git" ]; then
  git -C "$PROJECT" init -q
  printf 'export function backoff(attempt: number) {\n  return 200\n}\n' >"$PROJECT/src/retry.ts"
  git -C "$PROJECT" add -A
  git -C "$PROJECT" -c user.name=motion -c user.email=motion@example.invalid commit -qm "init"
fi

new() { # prompt [permission-mode]
  k new -p "$PROJECT" --mode "${2:-full-access}" --detach "$1" >/dev/null
  sleep "${GAP:-0.4}"
}
# Finished scenes first so the sidebar order puts the live ones on top.
new "SCENE_WORK Fix the retry loop"
new "SCENE_LONG Explain the retry design"
new "SCENE_FAIL Run the linter"
new "SCENE_SUBAGENT Audit slow queries with a subagent"
new "SCENE_DELEGATE Split the retry work"
sleep "${SETTLE:-14}"   # let the finished scenes complete before the waiting ones start
new "SCENE_APPROVAL Rebuild the project" supervised
new "SCENE_QUESTION Choose a cache" supervised
new "SCENE_LIVE Find slow queries across the services"
k threads
