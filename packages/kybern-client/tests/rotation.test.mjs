import test from "node:test"
import assert from "node:assert/strict"
import { applyEvent, emptyThreadState } from "../src/transcript.ts"

const T = "turn-1"
const AT = "2026-10-25T10:00:00Z"
const HARNESS = { kind: "claude", model: "opus" }
const CARRIED = { children: 3, pull_requests: 1, tasks: 0, commits: 5 }

function fold(events) {
  let state = emptyThreadState()
  events.forEach((payload, i) => {
    state = applyEvent(state, { seq: i + 1, turn_id: T, at: AT, ...payload })
  })
  return state
}

test("a rotation shows pending, then settles in place with its handoff", () => {
  const started = fold([{ kind: "context_rotation_started", rotation_id: "r1", reason: "budget", used_tokens: 201000, window_tokens: 1000000 }])
  const pending = started.blocks.filter((b) => b.kind === "rotation")
  assert.equal(pending.length, 1)
  assert.equal(pending[0].pending, true)
  assert.equal(pending[0].usedTokens, 201000)

  const limits = [{ name: "5h", used_percent: 10, window_minutes: 300, resets_at: null }]
  const state = fold([
    { kind: "provider_usage_updated", usage: { context: { used_tokens: 201000, window_tokens: 1000000 }, limits } },
    { kind: "context_rotation_started", rotation_id: "r1", reason: "budget", used_tokens: 201000, window_tokens: 1000000 },
    { kind: "context_rotated", rotation_id: "r1", reason: "budget", handoff: "## Goals\nShip it.", handoff_status: { status: "written" }, carried: CARRIED, from: HARNESS, to: HARNESS },
  ])
  const rows = state.blocks.filter((b) => b.kind === "rotation")
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, "rotation:r1")
  assert.equal(rows[0].pending, false)
  assert.equal(rows[0].usedTokens, 201000)
  assert.equal(rows[0].handoff, "## Goals\nShip it.")
  assert.deepEqual(rows[0].carried, CARRIED)
  assert.deepEqual(state.providerUsage, { limits }, "the fresh session starts with an empty meter; plan limits stay")

  const withoutLimits = fold([
    { kind: "provider_usage_updated", usage: { context: { used_tokens: 201000, window_tokens: 1000000 } } },
    { kind: "context_rotated", rotation_id: "r1", reason: "budget", handoff: null, handoff_status: { status: "written" }, carried: CARRIED, from: HARNESS, to: HARNESS },
  ])
  assert.equal(withoutLimits.providerUsage, undefined)
})

test("a refresh that failed before the release keeps the old session's meter", () => {
  const usage = { context: { used_tokens: 201000, window_tokens: 1000000 } }
  const state = fold([
    { kind: "provider_usage_updated", usage },
    { kind: "context_rotation_started", rotation_id: "r4", reason: "manual", used_tokens: 201000 },
    { kind: "context_rotated", rotation_id: "r4", reason: "manual", handoff: null, handoff_status: { status: "missing", why: "Kybern could not refresh the context: disk full" }, carried: CARRIED, from: HARNESS, to: HARNESS, session_kept: true },
  ])
  assert.deepEqual(state.providerUsage.context, usage.context)
  assert.equal(state.blocks.filter((b) => b.kind === "rotation")[0].pending, false, "the pending row still closes")
})

test("a missing handoff and a later edit", () => {
  const state = fold([
    { kind: "context_rotation_started", rotation_id: "r2", reason: "manual", used_tokens: 90000 },
    { kind: "context_rotated", rotation_id: "r2", reason: "manual", handoff: null, handoff_status: { status: "missing", why: "The previous session didn't respond." }, carried: CARRIED, from: HARNESS, to: HARNESS },
    { kind: "handoff_edited", rotation_id: "r2", text: "## Goals\nWritten by the user." },
  ])
  const [row] = state.blocks.filter((b) => b.kind === "rotation")
  assert.equal(row.handoffStatus.status, "missing")
  assert.equal(row.handoff, "## Goals\nWritten by the user.")
  assert.equal(row.edited, true)
})

test("a settled rotation without its start event still makes one row", () => {
  const state = fold([
    { kind: "context_rotated", rotation_id: "r3", reason: "harness_switch", handoff: "x", handoff_status: { status: "written" }, carried: CARRIED, from: HARNESS, to: { kind: "codex", model: "gpt-6.1-sol" } },
  ])
  const rows = state.blocks.filter((b) => b.kind === "rotation")
  assert.equal(rows.length, 1)
  assert.equal(rows[0].to.kind, "codex")
})
