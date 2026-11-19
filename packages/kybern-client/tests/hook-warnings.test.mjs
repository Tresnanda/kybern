import test from "node:test"
import assert from "node:assert/strict"
import { applyEvent, emptyThreadState, seedFromGet } from "../src/transcript.ts"
import { hookWarningDetails, hookWarningHelp, hookWarningOf, hookWarningTitle } from "../src/hookWarnings.ts"

const T = "turn-hooks"
const AT = "2026-11-19T10:00:00Z"
const ERROR = "Failed to run: Hook command references ${CLAUDE_PLUGIN_ROOT} but the hook is not associated with a plugin. This variable is only available in hooks defined in a plugin's hooks/hooks.json file, not in settings.json. Command: ${CLAUDE_PLUGIN_ROOT}/hooks/hook1.sh"
const CONTENT = "A hook gave no usable answer, so it didn't check this action."

const warning = (n, extra = {}, tool = "toolu_1") => ({
  kind: "provider_notice",
  level: "warning",
  text: CONTENT,
  data: { hook_no_verdict: { hook_event: "PreToolUse", tool_use_id: tool, timed_out: false, hook_name: "PreToolUse:Bash", command: `\${CLAUDE_PLUGIN_ROOT}/hooks/hook${n}.sh`, error: ERROR.replace("hook1", `hook${n}`), ...extra } },
})

function fold(payloads, state = emptyThreadState()) {
  payloads.forEach((payload, i) => {
    state = applyEvent(state, { seq: state.lastSeq + i + 1, turn_id: T, at: AT, ...payload })
  })
  return state
}

test("one hook warning is one row with the single-hook headline and its details", () => {
  const { blocks } = fold([warning(1)])
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].kind, "notice")
  assert.equal(blocks[0].text, "A hook couldn't check this action")
  assert.equal(blocks[0].hooks.length, 1)
  assert.match(hookWarningDetails(blocks[0].hooks), /^Your settings\n/)
  assert.match(hookWarningDetails(blocks[0].hooks), /CLAUDE_PLUGIN_ROOT/)
})

test("eight warnings of one call collapse into one row that names all eight hooks", () => {
  const { blocks } = fold(Array.from({ length: 8 }, (_, i) => warning(i + 1)))
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].text, "8 hooks couldn't check this action")
  assert.equal(blocks[0].hooks.length, 8)
  assert.equal(blocks[0].id, "notice:1", "the row keeps the first warning's identity")
  const details = hookWarningDetails(blocks[0].hooks)
  for (let n = 1; n <= 8; n++) assert.ok(details.includes(`hook${n}.sh`), `hook ${n} is listed`)
  assert.match(details, /^1\. Your settings/)
  assert.equal(hookWarningHelp(blocks[0].hooks), "These hooks are in your Claude settings but use a plugin-only variable. Remove them from settings.json.")
})

test("the same transcript read in one piece folds the same way", () => {
  const live = fold(Array.from({ length: 3 }, (_, i) => warning(i + 1)))
  const entries = live.blocks.length && Array.from({ length: 3 }, (_, i) => ({ role: "notice", turn_id: T, at: AT, seq: i + 1, level: "warning", text: CONTENT, data: warning(i + 1).data }))
  const seeded = seedFromGet({ thread: { last_seq: 3 }, transcript: entries, pending_approvals: [], notes: [] })
  assert.equal(seeded.blocks.length, 1)
  assert.deepEqual(seeded.blocks[0].hooks, live.blocks[0].hooks)
  assert.equal(seeded.blocks[0].text, "3 hooks couldn't check this action")
})

test("warnings of different turns, or with work between them, stay separate rows", () => {
  let state = fold([warning(1, {}, "toolu_1")])
  state = applyEvent(state, { seq: 2, turn_id: "other-turn", at: AT, ...warning(2, {}, "toolu_2") })
  assert.equal(state.blocks.length, 2)
  state = applyEvent(state, { seq: 3, turn_id: "other-turn", at: AT, kind: "provider_notice", level: "info", text: "something else", data: null })
  state = applyEvent(state, { seq: 4, turn_id: "other-turn", at: AT, ...warning(3, {}, "toolu_3") })
  assert.equal(state.blocks.length, 4, "an ordinary notice between them keeps the new warning apart")
})

test("a plugin hook shows its name and when it timed out, with no settings advice", () => {
  const hook = hookWarningOf({ hook_no_verdict: { tool_use_id: "t", timed_out: true, plugin_id: "acme@market", plugin_root: "/p" } })
  assert.deepEqual(hook, { toolUseId: "t", timedOut: true, plugin: "acme" })
  assert.equal(hookWarningDetails([hook]), "acme plugin\nTimed out")
  assert.equal(hookWarningHelp([hook]), null)
  assert.equal(hookWarningOf({ other: 1 }), null)
  assert.equal(hookWarningTitle(2), "2 hooks couldn't check this action")
})

test("a warning from an older daemon, with no per-hook fields, still folds and lists its hooks", () => {
  const bare = { kind: "provider_notice", level: "warning", text: CONTENT, data: { hook_no_verdict: { hook_event: "PreToolUse", tool_use_id: "t", timed_out: false } } }
  const { blocks } = fold([bare, bare])
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].text, "2 hooks couldn't check this action")
  assert.equal(hookWarningHelp(blocks[0].hooks), null)
})
