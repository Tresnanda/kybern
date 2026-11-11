import assert from "node:assert/strict"
import test from "node:test"

import {
  cacheLengthLabel,
  idleCompactionAt,
  idleCompactionFor,
  promptCacheCaption,
  promptCacheRemainingMinutes,
  promptCacheWindow,
} from "../lib/promptCache.ts"

const NOW = Date.parse("2026-11-08T14:00:00Z")

test("the countdown follows the cache the daemon recorded, not a guess", () => {
  // A subscription's 1-hour cache, written 8 minutes ago: no environment needed.
  const recorded = { ttl_seconds: 3600, expires_at: "2026-11-08T14:52:00Z", estimated: false }
  const window = promptCacheWindow("claude-code", recorded, "2026-11-08T13:51:00Z")
  assert.deepEqual(window, { ttlMinutes: 60, providerLabel: "Claude Code", expiresAt: Date.parse("2026-11-08T14:52:00Z") })
  assert.equal(promptCacheRemainingMinutes(window, NOW), 52)
  // An API key's 5-minute cache.
  const short = promptCacheWindow("claude-code", { ttl_seconds: 300, expires_at: "2026-11-08T14:03:30Z" }, undefined)
  assert.equal(promptCacheRemainingMinutes(short, NOW), 4)
  assert.equal(promptCacheRemainingMinutes(short, Date.parse("2026-11-08T14:10:00Z")), 0)
  // Codex's estimate is recorded too.
  assert.equal(promptCacheWindow("codex", { ttl_seconds: 1800, expires_at: "2026-11-08T14:20:00Z", estimated: true }, undefined).ttlMinutes, 30)
})

test("an unknown TTL shows no countdown", () => {
  assert.equal(promptCacheWindow("claude-code", { ttl_seconds: null, expires_at: null }, "2026-11-08T13:59:00Z"), null)
  assert.equal(promptCacheWindow("claude-code", {}, "2026-11-08T13:59:00Z"), null)
  assert.equal(promptCacheWindow("cursor", undefined, "2026-11-08T13:59:00Z"), null)
  assert.equal(promptCacheWindow("antigravity", { ttl_seconds: 300, expires_at: "2026-11-08T14:03:00Z" }, undefined), null)
})

test("threads from an older daemon keep the documented estimate", () => {
  assert.equal(promptCacheWindow("codex", undefined, "2026-11-08T13:59:00Z").ttlMinutes, 30)
  assert.equal(promptCacheWindow("claude-code", undefined, "2026-11-08T13:59:00Z").ttlMinutes, 5)
  assert.equal(promptCacheWindow("claude-code", undefined, "2026-11-08T13:59:00Z", { CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" }).ttlMinutes, 60)
  assert.equal(promptCacheWindow("claude-code", undefined, "2026-11-08T13:59:00Z", { ENABLE_PROMPT_CACHING_1H: "1", FORCE_PROMPT_CACHING_5M: "1" }).ttlMinutes, 5)
  assert.equal(promptCacheWindow("opencode", undefined, "2026-11-08T13:59:00Z"), null)
  assert.equal(promptCacheWindow("claude-code", undefined, "not-a-date"), null)
})

test("the caption names the real cache length and when Kybern compacts", () => {
  const window = { ttlMinutes: 60, providerLabel: "Claude Code", expiresAt: Date.parse("2026-11-08T15:00:00Z") }
  assert.equal(cacheLengthLabel(60), "1-hour")
  assert.equal(cacheLengthLabel(5), "5-minute")
  assert.equal(cacheLengthLabel(30), "30-minute")
  assert.equal(promptCacheCaption(window, "warm", 52, null), "This thread’s 1-hour cache has about 52 minutes left.")
  assert.equal(promptCacheCaption(window, "warm", 1, "14:58"), "This thread’s 1-hour cache has about 1 minute left. Kybern compacts it at 14:58 if you’re away.")
  assert.equal(promptCacheCaption(window, "active", 60, null), "Claude Code is actively using this conversation.")
  assert.equal(promptCacheCaption(window, "cold", 0, null), "This thread’s 1-hour cache has expired.")
})

test("Kybern compacts two minutes before expiry only when opted in and over 200K", () => {
  const window = { ttlMinutes: 60, providerLabel: "Claude Code", expiresAt: Date.parse("2026-11-08T15:00:00Z") }
  const at = Date.parse("2026-11-08T14:58:00Z")
  assert.equal(idleCompactionAt(window, "before_cache_expires", "claude-code", 312_000, NOW), at)
  assert.equal(idleCompactionAt(window, "before_cache_expires", "claude-code", 199_999, NOW), null)
  assert.equal(idleCompactionAt(window, "before_cache_expires", "claude-code", null, NOW), null)
  assert.equal(idleCompactionAt(window, "when_you_return", "claude-code", 312_000, NOW), null)
  assert.equal(idleCompactionAt(window, "before_cache_expires", "grok-build", 312_000, NOW), null)
  assert.equal(idleCompactionAt(window, "before_cache_expires", "claude-code", 312_000, Date.parse("2026-11-08T14:59:00Z")), Date.parse("2026-11-08T14:59:00Z"), "inside the window: now")
  assert.equal(idleCompactionAt(window, "before_cache_expires", "claude-code", 312_000, Date.parse("2026-11-08T14:59:45Z")), null, "too late")
})

test("an account's own choice wins over the global one", () => {
  const settings = {
    compaction: { idle: "before_cache_expires" },
    providers: { "claude-code": { env: {}, idle_compaction: { work: "never" } } },
  }
  assert.equal(idleCompactionFor(settings, { kind: "claude-code", instance: "work" }), "never")
  assert.equal(idleCompactionFor(settings, { kind: "claude-code", instance: "default" }), "before_cache_expires")
  assert.equal(idleCompactionFor({ providers: {} }, { kind: "codex", instance: "default" }), "when_you_return")
  assert.equal(idleCompactionFor(undefined, { kind: "codex", instance: "default" }), "when_you_return")
})
