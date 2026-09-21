import assert from "node:assert/strict"
import test from "node:test"

import { promptCacheRemainingMinutes, promptCacheWindow } from "./src/lib/promptCache.ts"

test("uses the documented Codex 30-minute warm window", () => {
  assert.deepEqual(promptCacheWindow("codex"), { ttlMinutes: 30, providerLabel: "Codex" })
})

test("uses Claude Code's configured 5-minute or 1-hour window", () => {
  assert.equal(promptCacheWindow("claude-code")?.ttlMinutes, 5)
  assert.equal(promptCacheWindow("claude-code", { CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" })?.ttlMinutes, 60)
  assert.equal(promptCacheWindow("claude-code", { ENABLE_PROMPT_CACHING_1H: "1" })?.ttlMinutes, 60)
  assert.equal(promptCacheWindow("claude-code", {
    ENABLE_PROMPT_CACHING_1H: "1",
    FORCE_PROMPT_CACHING_5M: "1",
  })?.ttlMinutes, 5)
})

test("does not invent cache windows for provider-aggregating harnesses", () => {
  assert.equal(promptCacheWindow("opencode"), null)
  assert.equal(promptCacheWindow("pi"), null)
  assert.equal(promptCacheWindow("omp"), null)
  assert.equal(promptCacheWindow("cursor"), null)
})

test("rounds the warm countdown up and reaches zero", () => {
  const now = Date.parse("2026-09-21T12:00:00Z")
  assert.equal(promptCacheRemainingMinutes("2026-09-21T12:01:00Z", 30, now), 30)
  assert.equal(promptCacheRemainingMinutes("2026-09-21T11:31:00Z", 30, now), 1)
  assert.equal(promptCacheRemainingMinutes("2026-09-21T11:29:59Z", 30, now), 0)
  assert.equal(promptCacheRemainingMinutes("not-a-date", 30, now), 0)
})
