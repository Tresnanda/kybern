import test from "node:test"
import assert from "node:assert/strict"
import { handoffSections, missingHandoffText, rotationLabel, rotationMeta, tokenCount } from "../src/rotation.ts"

const clock = (date) => `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`
const block = (overrides = {}) => ({
  kind: "rotation",
  id: "rotation:r1",
  turnId: "t1",
  at: "2026-10-25T14:02:00Z",
  seq: 3,
  rotationId: "r1",
  reason: "budget",
  pending: false,
  usedTokens: 201000,
  windowTokens: 1000000,
  handoff: "## Goals\nShip it.",
  handoffStatus: { status: "written" },
  edited: false,
  carried: { children: 3, pull_requests: 1, tasks: 0, commits: 5 },
  from: { kind: "claude-code" },
  to: { kind: "claude-code" },
  ...overrides,
})

test("the row label follows the reason and the handoff", () => {
  assert.equal(rotationLabel(block({ pending: true }), clock), "Refreshing context…")
  assert.equal(rotationLabel(block(), clock), "Context refreshed · 14:02")
  assert.equal(rotationLabel(block({ reason: "idle" }), clock), "Context refreshed · 14:02")
  assert.equal(rotationLabel(block({ reason: "manual" }), clock), "Context refreshed by you · 14:02")
  assert.equal(
    rotationLabel(block({ handoff: null, handoffStatus: { status: "missing", why: "timed out" } }), clock),
    "Context refreshed without a handoff · 14:02",
  )
  assert.equal(
    rotationLabel(block({ reason: "harness_switch", to: { kind: "codex", model: "gpt-6.1-sol" } }), clock),
    "Switched to Codex · context carried",
  )
  assert.equal(rotationLabel(block({ at: "not a date" }), clock), "Context refreshed")
})

test("the meta line phrases the reason and pluralises what was carried", () => {
  assert.equal(rotationMeta(block()), "Passed 201k tokens · carried 3 agents, 1 pull request, 5 commits")
  assert.equal(
    rotationMeta(block({ carried: { children: 1, pull_requests: 2, tasks: 1, commits: 1 } })),
    "Passed 201k tokens · carried 1 agent, 2 pull requests, 1 task, 1 commit",
  )
  assert.equal(rotationMeta(block({ reason: "idle", usedTokens: 120000 })), "Idle with 120k tokens used · carried 3 agents, 1 pull request, 5 commits")
  assert.equal(rotationMeta(block({ reason: "manual", usedTokens: 90000, carried: { children: 0, pull_requests: 0, tasks: 0, commits: 0 } })), "Refreshed by you at 90k tokens · carried the recent messages")
  assert.equal(
    rotationMeta(block({ handoffStatus: { status: "missing", why: "x" }, carried: { children: 2, pull_requests: 0, tasks: 0, commits: 4 } })),
    "Passed 201k tokens · carried 2 agents, 4 commits and the recent messages",
  )
  assert.equal(
    rotationMeta(block({ reason: "harness_switch", usedTokens: 0, from: { kind: "claude-code" }, to: { kind: "codex" } })),
    "Moved from Claude Code to Codex · carried 3 agents, 1 pull request, 5 commits",
  )
  assert.equal(rotationMeta(block({ carried: null, usedTokens: 0 })), "Passed the context budget")
  assert.equal(tokenCount(950), "950")
})

test("a handoff splits into its sections without the heading hints", () => {
  const text = "## Goals\nShip.\n\n## Decisions (date, what, why, commit if any)\nOct 24 · Sessions stay server-side.\n\n## Open questions\n"
  assert.deepEqual(handoffSections(text), [
    { heading: "Goals", body: "Ship." },
    { heading: "Decisions", body: "Oct 24 · Sessions stay server-side." },
    { heading: "Open questions", body: "None" },
  ])
  assert.deepEqual(handoffSections("Just a note."), [{ heading: "", body: "Just a note." }])
  assert.deepEqual(handoffSections(null), [])
})

test("a missing handoff explains itself", () => {
  const text = missingHandoffText(block({ handoffStatus: { status: "missing", why: "The previous session didn't respond within 90 seconds." } }))
  assert.match(text, /^The previous session didn't respond within 90 seconds\. The new session started from Kybern's facts/)
  assert.match(missingHandoffText(block({ handoffStatus: null })), /^The previous session didn't write a handoff\./)
})
