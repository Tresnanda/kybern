import assert from "node:assert/strict"
import test from "node:test"
import { limitFamily, limitLabel, limitPace, resetIn, windowLabel } from "../lib/providerUsage.ts"

const now = Date.UTC(2026, 10, 19, 15, 0, 0)

test("a limit keeps the models it covers in its name", () => {
  const covered = { name: "Claude and GPT models · 5-hour", used_percent: 0, window_minutes: 300, resets_at: null }
  assert.equal(limitLabel(covered, "antigravity"), "Claude and GPT models · 5-hour")
  assert.equal(limitLabel({ ...covered, name: "Gemini Models · Weekly", window_minutes: 10080 }, "antigravity"), "Gemini Models · Weekly")
  assert.equal(limitFamily(covered), "Claude and GPT models")
  assert.equal(windowLabel(covered), "5-hour")
  // Harnesses that name only the window are unchanged.
  assert.equal(limitLabel({ name: "five_hour", used_percent: 10, window_minutes: 300, resets_at: null }, "claude-code"), "Current session")
  assert.equal(limitLabel({ name: "5-hour", used_percent: 10, window_minutes: 300, resets_at: null }, "codex"), "5-hour")
  assert.equal(limitFamily({ name: "five_hour", used_percent: 10, window_minutes: 300, resets_at: null }), null)
})

test("no reset time shows no reset line rather than a guess", () => {
  assert.equal(resetIn(null, now), null)
  assert.equal(resetIn(undefined, now), null)
  assert.equal(resetIn(now / 1000 + 130 * 60, now), "Resets in 2h 10m")
  // The pace marker needs a reset time too, so the whole line goes.
  assert.equal(limitPace({ name: "x · 5-hour", used_percent: 0, window_minutes: 300, resets_at: null }, now), null)
})
