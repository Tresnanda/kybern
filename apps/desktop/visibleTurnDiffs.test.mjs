import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const desktop = fileURLToPath(new URL(".", import.meta.url))

test("visible-thread turn diffs are bounded; native A/B restores the unbound set", () => {
  const retention = readFileSync(path.join(desktop, "src/state/retention.ts"), "utf8")
  const check = readFileSync(path.join(desktop, "scripts/check-rendering.mjs"), "utf8")
  const fixture = readFileSync(path.join(desktop, "perf/live-tool-memory.tsx"), "utf8")

  assert.match(retention, /export const VISIBLE_TURN_DIFFS = 16/)
  assert.match(retention, /VITE_LIVE_TOOLS_UNBOUND_TURN_DIFFS/)
  assert.match(retention, /boundVisibleTurnDiffs/)
  assert.match(retention, /isWholeThreadDiffKey/)
  assert.doesNotMatch(retention, /visible\.has\(threadId\) \|\| !touched\.has\(key\)\) touched\.set\(key/)

  assert.match(check, /VITE_LIVE_TOOLS_UNBOUND_TURN_DIFFS/)
  assert.match(check, /KYBERN_PERF_LIVE_UNBOUND_TURN_DIFFS/)

  assert.match(fixture, /VITE_LIVE_TOOLS_UNBOUND_TURN_DIFFS/)
  assert.match(fixture, /VISIBLE_TURN_DIFFS/)
  assert.match(fixture, /checkVisibleTurnDiffs/)
})
