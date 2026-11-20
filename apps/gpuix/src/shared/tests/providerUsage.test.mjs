import assert from "node:assert/strict"
import test from "node:test"
import { limitFamily, limitLabel, limitPace, resetIn, staleCaption, staleFix, staleReason, windowLabel } from "../lib/providerUsage.ts"

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

test("a signed-out Antigravity says to sign in and offers the sign-in action; no other state has a button", () => {
  const entry = { provider: "antigravity", stale: "signed_out", updated_at: new Date(now - 3 * 3600_000).toISOString() }
  assert.equal(staleReason(entry, now), "Sign in to Antigravity to update limits.")
  assert.equal(staleCaption(entry, now), "Last updated 3 h ago. Sign in to Antigravity to update limits.")
  assert.deepEqual(staleFix(entry), { id: "sign_in", label: "Sign in", params: { provider: "antigravity" } })
  assert.deepEqual(staleFix({ ...entry, instance: "work" })?.params, { provider: "antigravity", instance: "work" })
  for (const stale of ["login_refresh", "throttled", "unavailable", "from_last_run", undefined]) {
    assert.equal(staleFix({ ...entry, stale }), undefined, String(stale))
  }
  // The other captions are unchanged, and a state an older client doesn't know shows nothing.
  assert.equal(staleReason({ ...entry, stale: "login_refresh" }, now), "Waiting for Antigravity to refresh its sign-in.")
  assert.equal(staleReason({ ...entry, stale: "something_new" }, now), null)
})
