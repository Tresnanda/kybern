import test from "node:test"
import assert from "node:assert/strict"
import {
  carriedPhrase, effectiveRotationBudget, formatTokens, handoffEditable, missingHandoffText, parseHandoff,
  rotationBudgetChoices, rotationLabel, rotationMeta, ROTATION_BUDGET_OPTIONS,
} from "../src/rotation.ts"
import { cleanOverrides, effectiveCoordinatorSettings, settingValueLabel, withOverrideField } from "../src/coordinatorSettings.ts"

const CARRIED = { children: 3, pull_requests: 1, tasks: 0, commits: 5 }
const base = { reason: "budget", pending: false, usedTokens: 203412, handoffStatus: { status: "written" }, carried: CARRIED, to: { kind: "claude-code" } }

test("token counts read as 142k, 1M and 1.5M", () => {
  assert.equal(formatTokens(950), "950")
  assert.equal(formatTokens(142_000), "142k")
  assert.equal(formatTokens(200_000), "200k")
  assert.equal(formatTokens(1_000_000), "1M")
  assert.equal(formatTokens(1_500_000), "1.5M")
  assert.equal(formatTokens(0), "0")
})

test("the row says what happened, by reason", () => {
  assert.equal(rotationLabel({ ...base, pending: true }, "14:02"), "Refreshing context…")
  assert.equal(rotationLabel(base, "14:02"), "Context refreshed · 14:02")
  assert.equal(rotationLabel({ ...base, reason: "idle" }, "14:02"), "Context refreshed · 14:02")
  assert.equal(rotationLabel({ ...base, reason: "manual" }, "16:20"), "Context refreshed by you · 16:20")
  assert.equal(rotationLabel({ ...base, reason: "harness_switch", to: { kind: "codex" } }, "9:41"), "Switched to Codex · context carried")
  assert.equal(rotationLabel({ ...base, handoffStatus: { status: "missing", why: "timed out" } }, "9:41"), "Context refreshed without a handoff · 9:41")
})

test("the meta line names the reason and what was carried, with plurals", () => {
  assert.equal(rotationMeta(base), "Passed 200k tokens · carried 3 agents, 1 pull request, 5 commits")
  assert.equal(rotationMeta({ ...base, carried: { children: 1, pull_requests: 0, tasks: 2, commits: 1 } }), "Passed 200k tokens · carried 1 agent, 2 tasks, 1 commit")
  assert.equal(rotationMeta({ ...base, usedTokens: 71_000 }), "Passed 70k tokens · carried 3 agents, 1 pull request, 5 commits")
  assert.equal(rotationMeta({ ...base, reason: "idle" }), "Refreshed after sitting idle · carried 3 agents, 1 pull request, 5 commits")
  assert.equal(rotationMeta({ ...base, reason: "manual", carried: { children: 0, pull_requests: 0, tasks: 0, commits: 0 } }), "Refreshed by you")
  assert.equal(rotationMeta({ ...base, reason: "harness_switch", to: { kind: "codex" } }), "Switched to Codex · carried 3 agents, 1 pull request, 5 commits")
  assert.equal(rotationMeta({ ...base, handoffStatus: { status: "missing", why: "x" }, carried: { children: 2, pull_requests: 0, tasks: 0, commits: 4 } }), "Passed 200k tokens · carried 2 agents, 4 commits and the recent messages")
  assert.equal(carriedPhrase(null), null)
})

test("a missing handoff says why and what happens next", () => {
  assert.match(missingHandoffText({ status: "missing", why: "Kybern restarted before the handoff was written." }), /^Kybern restarted before the handoff was written\. The new session started from Kybern's facts and the recent messages/)
  assert.match(missingHandoffText(null), /^The previous session did not leave a handoff\. The new session/)
})

test("a handoff splits at its headings, dropping the prompt's hints from the labels", () => {
  const sections = parseHandoff("## Goals\nShip it.\n\n## Decisions (date, what, why, commit if any)\nOct 24 · Sessions stay server-side (`a41c9e2`).\n\n## Reversals and removals\nNone\n\n## Next steps\n- Wait for the review.\n- Merge.\n")
  assert.deepEqual(sections.map((s) => s.label), ["Goals", "Decisions", "Reversals and removals", "Next steps"])
  assert.equal(sections[1].heading, "Decisions (date, what, why, commit if any)")
  assert.equal(sections[1].body, "Oct 24 · Sessions stay server-side (`a41c9e2`).")
  assert.deepEqual(sections.map((s) => s.none), [false, false, true, false])
  assert.equal(sections[3].body, "- Wait for the review.\n- Merge.")
  assert.deepEqual(parseHandoff(null), [])
  assert.deepEqual(parseHandoff("  \n"), [])
  const loose = parseHandoff("Just prose.\n## Goals\nx")
  assert.equal(loose[0].label, "")
  assert.equal(loose[0].body, "Just prose.")
})

test("saving needs a changed, non-blank handoff", () => {
  assert.equal(handoffEditable("  ", "x"), false)
  assert.equal(handoffEditable("x\n", "x"), false)
  assert.equal(handoffEditable("y", "x"), true)
  assert.equal(handoffEditable("y", null), true)
})

test("the refresh point is the budget, capped at half the window; zero is off", () => {
  assert.equal(effectiveRotationBudget(200_000, 1_000_000), 200_000)
  assert.equal(effectiveRotationBudget(400_000, 200_000), 100_000)
  assert.equal(effectiveRotationBudget(0, 1_000_000), 0)
  assert.equal(effectiveRotationBudget(undefined, null), 200_000)
  assert.equal(effectiveRotationBudget(150_000, null), 150_000)
})

test("the budget pick list is 100k, 200k, 400k, Off and keeps a value set elsewhere", () => {
  assert.deepEqual(ROTATION_BUDGET_OPTIONS.map((o) => o.label), ["100k", "200k", "400k", "Off"])
  assert.deepEqual(rotationBudgetChoices(200_000).map((o) => o.value), ["100000", "200000", "400000", "0"])
  assert.deepEqual(rotationBudgetChoices(150_000).map((o) => o.label), ["100k", "200k", "400k", "150k", "Off"])
})

test("a project's budget overrides Settings, survives cleaning, and 0 is a value", () => {
  assert.equal(effectiveCoordinatorSettings(undefined, undefined).rotation_budget_tokens, 200_000)
  assert.equal(effectiveCoordinatorSettings({ rotation_budget_tokens: 400_000 }, undefined).rotation_budget_tokens, 400_000)
  assert.equal(effectiveCoordinatorSettings({ rotation_budget_tokens: 400_000 }, { rotation_budget_tokens: 0 }).rotation_budget_tokens, 0)
  assert.deepEqual(cleanOverrides({ rotation_budget_tokens: 100_000 }), { rotation_budget_tokens: 100_000 })
  assert.deepEqual(withOverrideField({ lead_autonomy: "act" }, "rotation_budget_tokens", 0), { lead_autonomy: "act", rotation_budget_tokens: 0 })
  assert.equal(withOverrideField({ rotation_budget_tokens: 100_000 }, "rotation_budget_tokens", null), null)
  assert.equal(settingValueLabel("rotation_budget_tokens", 400_000, []), "400k")
  assert.equal(settingValueLabel("rotation_budget_tokens", 0, []), "Off")
})
