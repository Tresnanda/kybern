import test from "node:test"
import assert from "node:assert/strict"
import { applyEvent, emptyThreadState, groupTurns, seedFromGet } from "../src/transcript.ts"
import { autoCompactLabel, idleCompactionDetail, idleCompactionMeta, idleCompactionRowLabel, tokenSize } from "../src/compaction.ts"

const T = "turn-idle"
const AT = "2026-11-08T14:58:00Z"
const EXPIRES = "2026-11-08T15:00:00Z"
const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }
const compact = { parts: [{ type: "text", text: "/compact" }] }

function fold(payloads, state = emptyThreadState()) {
  payloads.forEach((payload, i) => {
    state = applyEvent(state, { seq: state.lastSeq + i + 1, turn_id: T, at: AT, ...payload })
  })
  return state
}

test("an idle compaction is one notice row: no /compact message, no harness notices", () => {
  const running = fold([
    { kind: "turn_started", message_id: "m1", message: compact },
    { kind: "idle_compaction_started", context_tokens: 312_000, cache_expires_at: EXPIRES, cache_ttl_seconds: 3600 },
    { kind: "provider_notice", level: "info", text: "compacting context", data: null },
  ])
  assert.deepEqual(running.blocks.map((b) => b.kind), ["idle_compaction"])
  const [row] = running.blocks
  assert.equal(row.finishedAt, null)
  assert.equal(idleCompactionRowLabel(row, "14:58"), "Compacting…")

  const done = fold([
    { kind: "provider_notice", level: "info", text: "Context compacted to 38000 tokens", data: { trigger: "manual", pre_tokens: 312_000, post_tokens: 38_000 } },
    { kind: "provider_usage_updated", usage: { context: { used_tokens: 38_000, window_tokens: 1_000_000 } } },
    { kind: "turn_completed", stop_reason: "completed", usage: USAGE, cost_usd: null, duration_ms: 9000 },
  ], running)
  const settled = done.blocks.find((b) => b.kind === "idle_compaction")
  assert.equal(settled.contextAfter, 38_000)
  assert.equal(settled.finishedAt, AT)
  assert.equal(settled.failed, false)
  assert.equal(done.blocks.filter((b) => b.kind === "notice").length, 0)
  const [turn] = groupTurns(done.blocks)
  assert.equal(turn.user, null, "the turn has no user message")
  assert.ok(turn.work.some((b) => b.kind === "idle_compaction"))
  assert.equal(idleCompactionRowLabel(settled, "14:58"), "Compacted while you were away · 14:58")
  assert.equal(idleCompactionMeta(settled), "312K → 38K tokens · 2 minutes before the 1-hour cache expired")
})

test("a warning during an idle compaction stays visible, and a failed one says so", () => {
  const state = fold([
    { kind: "turn_started", message_id: "m1", message: compact },
    { kind: "idle_compaction_started", context_tokens: 250_000, cache_expires_at: EXPIRES },
    { kind: "provider_notice", level: "warning", text: "Rate limited", data: null },
    { kind: "turn_failed", error: "rate limited" },
  ])
  assert.ok(state.blocks.some((b) => b.kind === "notice" && b.text === "Rate limited"))
  const row = state.blocks.find((b) => b.kind === "idle_compaction")
  assert.equal(row.failed, true)
  assert.equal(idleCompactionRowLabel(row, "14:58"), "Couldn’t compact while you were away · 14:58")
  assert.equal(idleCompactionMeta(row), "250K tokens · 2 minutes before the cache expired")
})

test("ordinary turns and a manual /compact keep their messages and notices", () => {
  const state = fold([
    { kind: "turn_started", message_id: "m1", message: compact },
    { kind: "provider_notice", level: "info", text: "Context compacted to 38000 tokens", data: { post_tokens: 38_000 } },
    { kind: "turn_completed", stop_reason: "completed", usage: USAGE, cost_usd: null, duration_ms: 9000 },
  ])
  assert.deepEqual(state.blocks.map((b) => b.kind), ["user", "notice", "turn_end"])
})

test("a reopened thread shows the stored idle compaction the same way", () => {
  const state = seedFromGet({
    thread: { id: "t", last_seq: 5 },
    transcript: [
      { role: "user", id: "u0", turn_id: "earlier", seq: 1, message: { parts: [{ type: "text", text: "Refactor the parser" }] }, at: AT },
      { role: "user", id: "m1", turn_id: T, seq: 2, message: compact, at: AT },
      { role: "notice", turn_id: T, seq: 3, level: "info", text: "Compacted while you were away", at: AT, data: { kind: "idle_compaction", context_tokens: 312_000, cache_expires_at: EXPIRES, cache_ttl_seconds: 3600 } },
      { role: "notice", turn_id: T, seq: 4, level: "info", text: "Context compacted to 38000 tokens", at: AT, data: { post_tokens: 38_000 } },
      { role: "turn_summary", turn_id: T, seq: 5, at: "2026-11-08T14:58:20Z", stop_reason: "completed", usage: USAGE, cost_usd: null, duration_ms: 20000 },
    ],
    pending_approvals: [],
  })
  const kinds = state.blocks.filter((b) => b.turnId === T).map((b) => b.kind)
  assert.ok(!kinds.includes("user") && !kinds.includes("notice"), `got ${kinds}`)
  const row = state.blocks.find((b) => b.kind === "idle_compaction")
  assert.equal(row.contextAfter, 38_000)
  assert.equal(row.finishedAt, "2026-11-08T14:58:20Z")
  assert.equal(row.cacheTtlSeconds, 3600)
  assert.ok(state.blocks.some((b) => b.kind === "user" && b.id === "u0"), "other turns keep their messages")
})

test("compaction words", () => {
  assert.equal(tokenSize(312_000), "312K")
  assert.equal(tokenSize(1_000_000), "1M")
  assert.equal(tokenSize(750_000), "750K")
  assert.equal(autoCompactLabel(null), "Default")
  assert.equal(autoCompactLabel(150_000), "150K")
  assert.equal(idleCompactionDetail("before_cache_expires"), "Compacts before the cache expires")
})
