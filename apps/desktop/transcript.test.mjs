import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { registerHooks } from "node:module"
import test from "node:test"

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/hot") {
      return {
        shortCircuit: true,
        url: new URL("./src/lib/hot.ts", import.meta.url).href,
      }
    }
    return nextResolve(specifier, context)
  },
})

const { applyEvent, buildWorkHierarchy, emptyThreadState, groupTurns, shouldRevealLiveText } = await import(
  "./src/state/transcript.ts"
)

const T = "turn-1"
const AT = "2026-09-03T00:00:00Z"
const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }
const ROOT = { kind: "root" }
const agentOrigin = (taskId, providerThreadId = null) => ({
  kind: "agent",
  task_id: taskId,
  provider_thread_id: providerThreadId,
})
const readTool = (id) => ({ id, name: "Read", input: {}, parent_id: null })
const runtimeTask = (id, overrides = {}) => ({
  id,
  thread_id: "thread-1",
  origin_turn_id: T,
  kind: "agent",
  status: "running",
  title: "Subagent",
  detail: null,
  provider_type: "sub_agent",
  parent_id: null,
  tool_call_id: null,
  provider_thread_id: id,
  model: null,
  effort: null,
  backgrounded: true,
  last_tool_name: null,
  usage: null,
  stats: {},
  capabilities: { stop: true, background: false },
  started_at: AT,
  updated_at: AT,
  completed_at: null,
  ...overrides,
})

// Fold a list of event payloads through the real reducer, assigning sequence.
function fold(payloads) {
  let state = emptyThreadState()
  payloads.forEach((payload, i) => {
    state = applyEvent(state, { seq: i + 1, turn_id: T, at: AT, ...payload })
  })
  return state
}

const start = { kind: "turn_started", message_id: "u1", message: { parts: [{ type: "text", text: "hi" }] } }
const done = { kind: "turn_completed", stop_reason: "completed", usage: USAGE, cost_usd: null, duration_ms: 5 }

test("one message preserves its live segments around a tool, then rejoins only after settlement", () => {
  const state = fold([
    start,
    { kind: "assistant_text_delta", message_id: "m1", delta: "Let me look. ", origin: ROOT },
    { kind: "tool_call_started", call: readTool("read-1"), origin: ROOT },
    { kind: "tool_call_completed", tool_call_id: "read-1", output: null, is_error: false },
    { kind: "assistant_text_delta", message_id: "m1", delta: "Here is the answer.", origin: ROOT },
    { kind: "assistant_message_completed", message_id: "m1", text: "Let me look. Here is the answer.", thinking: null, origin: ROOT },
    done,
  ])
  const [group] = groupTurns(state.blocks)

  assert.deepEqual(
    state.blocks.filter((block) => block.kind !== "user" && block.kind !== "turn_end").map((block) =>
      block.kind === "assistant"
        ? `assistant:${block.segment}:${block.seq}:${block.text}`
        : `tool:${block.seq}:${block.call.id}`,
    ),
    [
      "assistant:0:2:Let me look. ",
      "tool:3:read-1",
      "assistant:1:5:Here is the answer.",
    ],
  )
  assert.equal(group.answer?.text, "Let me look. Here is the answer.")
  assert.deepEqual(
    group.work.map((b) => (b.kind === "tool" ? `tool:${b.call.id}` : b.kind)),
    ["tool:read-1"],
  )
})

test("completion-only text after a tool opens a new sequence row", () => {
  const state = fold([
    start,
    { kind: "assistant_text_delta", message_id: "m1", delta: "I will inspect. ", origin: ROOT },
    { kind: "tool_call_started", call: readTool("read-1"), origin: ROOT },
    { kind: "tool_call_completed", tool_call_id: "read-1", output: null, is_error: false },
    { kind: "assistant_message_completed", message_id: "m1", text: "I will inspect. Found it.", thinking: null, origin: ROOT },
  ])

  assert.deepEqual(
    state.blocks.filter((block) => block.kind === "assistant").map((block) => `${block.segment}:${block.seq}:${block.text}`),
    ["0:2:I will inspect. ", "1:5:Found it."],
  )
})

test("an earlier separate message stays muted work; the final message is the answer", () => {
  const state = fold([
    start,
    { kind: "assistant_text_delta", message_id: "m1", delta: "Let me check the files.", origin: ROOT },
    { kind: "assistant_message_completed", message_id: "m1", text: "Let me check the files.", thinking: null, origin: ROOT },
    { kind: "tool_call_started", call: readTool("read-1"), origin: ROOT },
    { kind: "tool_call_completed", tool_call_id: "read-1", output: null, is_error: false },
    { kind: "assistant_text_delta", message_id: "m2", delta: "Found it.", origin: ROOT },
    { kind: "assistant_message_completed", message_id: "m2", text: "Found it.", thinking: null, origin: ROOT },
    done,
  ])
  const [group] = groupTurns(state.blocks)

  assert.equal(group.answer?.text, "Found it.")
  assert.deepEqual(
    group.work.map((b) => (b.kind === "assistant" ? `assistant:${b.text}` : `tool:${b.call.id}`)),
    ["assistant:Let me check the files.", "tool:read-1"],
  )
})

test("a Claude continuation after a provisional result stays in the parent turn and becomes its answer", () => {
  const finalText = "Both subagents are back — this is the final answer."
  const events = JSON.parse(readFileSync(new URL("../../fixtures/transcript/claude-background-continuation.json", import.meta.url), "utf8"))
  let state = emptyThreadState()
  for (const event of events) state = applyEvent(state, event)
  const groups = groupTurns(state.blocks)

  assert.equal(groups.length, 1)
  assert.equal(groups[0]?.answer?.text, finalText)
  assert.deepEqual(
    groups[0]?.work.filter((block) => block.kind === "assistant").map((block) => block.text),
    ["Holding for the last agent."],
  )
})

test("reasoning splits into a work row and out of the answer", () => {
  const state = fold([
    start,
    { kind: "assistant_thinking_delta", message_id: "m1", delta: "I should inspect first.", origin: ROOT },
    { kind: "assistant_text_delta", message_id: "m1", delta: "Here is the answer.", origin: ROOT },
    { kind: "assistant_message_completed", message_id: "m1", text: "Here is the answer.", thinking: "I should inspect first.", origin: ROOT },
    done,
  ])
  const [group] = groupTurns(state.blocks)

  assert.equal(group.answer?.text, "Here is the answer.")
  assert.equal(group.answer?.thinking, "")
  const reasoning = group.work.find((b) => b.kind === "assistant")
  assert.equal(reasoning?.text, "")
  assert.equal(reasoning?.thinking, "I should inspect first.")
})

test("a live turn keeps assistant narration in place and exposes no final answer", () => {
  const state = fold([start, { kind: "assistant_text_delta", message_id: "m1", delta: "Streaming answer so far", origin: ROOT }])
  const [group] = groupTurns(state.blocks)

  assert.equal(group.running, true)
  assert.equal(group.answer, null)
  assert.equal(group.liveTextId, "m1#0")
  assert.deepEqual(group.work.filter((block) => block.kind === "assistant").map((block) => block.text), ["Streaming answer so far"])
})

test("main narration, root tools, subagents, child tools, and later narration keep one stable order", () => {
  const agentCall = { ...readTool("agent-1"), name: "Agent" }
  const childCall = { ...readTool("child-read"), parent_id: "agent-1" }
  const state = fold([
    start,
    { kind: "assistant_text_delta", message_id: "m1", delta: "I will inspect first.", origin: ROOT },
    { kind: "assistant_message_completed", message_id: "m1", text: "I will inspect first.", thinking: null, origin: ROOT },
    { kind: "tool_call_started", call: readTool("root-read"), origin: ROOT },
    { kind: "tool_call_completed", tool_call_id: "root-read", output: null, is_error: false },
    { kind: "tool_call_started", call: agentCall, origin: ROOT },
    { kind: "runtime_task_started", task: runtimeTask("agent-task", { tool_call_id: "agent-1" }) },
    { kind: "tool_call_started", call: childCall, origin: agentOrigin("agent-task", "provider-child") },
    { kind: "tool_call_completed", tool_call_id: "child-read", output: null, is_error: false },
    { kind: "runtime_task_started", task: runtimeTask("native-agent") },
    { kind: "assistant_text_delta", message_id: "m2", delta: "The agents are still working.", origin: ROOT },
  ])
  const [group] = groupTurns(state.blocks)
  const hierarchy = buildWorkHierarchy(group.work)

  assert.equal(group.answer, null)
  assert.equal(group.liveTextId, "m2#0")
  assert.deepEqual(
    hierarchy.roots.map((block) =>
      block.kind === "assistant"
        ? `assistant:${block.text}`
        : block.kind === "tool"
          ? `tool:${block.call.id}`
          : block.kind === "runtime_task"
            ? `task:${block.task.id}`
            : block.kind,
    ),
    [
      "assistant:I will inspect first.",
      "tool:root-read",
      "tool:agent-1",
      "task:native-agent",
      "assistant:The agents are still working.",
    ],
  )
  assert.deepEqual(hierarchy.childrenByParent.get("agent-1")?.map((block) => block.call.id), ["child-read"])
})

test("runtime task progress updates its launch row without moving it", () => {
  const state = fold([
    start,
    { kind: "runtime_task_started", task: runtimeTask("native-agent") },
    { kind: "tool_call_started", call: readTool("root-read"), origin: ROOT },
    {
      kind: "runtime_task_updated",
      task: runtimeTask("native-agent", {
        status: "waiting",
        detail: "Waiting for another agent",
        updated_at: "2026-09-03T00:00:05Z",
      }),
    },
  ])
  const taskBlock = state.blocks.find((block) => block.kind === "runtime_task")

  assert.equal(taskBlock?.seq, 2)
  assert.equal(taskBlock?.task.updated_seq, 4)
  assert.equal(taskBlock?.task.status, "waiting")
  assert.deepEqual(
    state.blocks.filter((block) => block.kind !== "user").map((block) => block.kind),
    ["runtime_task", "tool"],
  )
})

test("agent-owned assistant chatter never enters the root transcript", () => {
  const state = fold([
    start,
    { kind: "assistant_text_delta", message_id: "child-m1", delta: "child progress", origin: agentOrigin("agent-task") },
    { kind: "assistant_message_completed", message_id: "child-m1", text: "child progress", thinking: null, origin: agentOrigin("agent-task") },
    { kind: "assistant_text_delta", message_id: "root-m1", delta: "root progress", origin: ROOT },
  ])

  assert.deepEqual(
    state.blocks.filter((block) => block.kind === "assistant").map((block) => block.text),
    ["root progress"],
  )
})

test("captured Codex mixed turn matches the live reducer and stable hierarchy", () => {
  const events = JSON.parse(readFileSync(new URL("../../fixtures/transcript/codex-mixed-agent-turn.json", import.meta.url), "utf8"))
  let state = emptyThreadState()
  for (const event of events) state = applyEvent(state, event)

  const signature = state.blocks.map((block) => {
    if (block.kind === "user") return `user:${block.seq}`
    if (block.kind === "assistant") return `assistant:${block.seq}:${block.text}`
    if (block.kind === "tool") return `tool:${block.seq}:${block.call.id}`
    if (block.kind === "runtime_task") return `task:${block.seq}:${block.task.id}:${block.task.status}`
    if (block.kind === "turn_end") return `end:${block.seq}`
    return `other:${block.kind}`
  })
  assert.deepEqual(signature, [
    "user:1",
    "assistant:2:I’ll inspect the renderer first.",
    "tool:4:root-read",
    "tool:6:agent-call",
    "task:7:agent-task:completed",
    "tool:8:child-search",
    "task:12:native-agent:completed",
    "assistant:13:The ordered transcript is ready.",
    "end:15",
  ])

  const [group] = groupTurns(state.blocks)
  const hierarchy = buildWorkHierarchy(group.work)
  assert.deepEqual(
    hierarchy.roots.map((block) => block.kind === "tool" ? block.call.id : block.kind === "runtime_task" ? block.task.id : block.kind),
    ["assistant", "root-read", "agent-call", "native-agent"],
  )
  assert.deepEqual(hierarchy.childrenByParent.get("agent-call")?.map((block) => block.call.id), ["child-search"])
  assert.equal(group.answer?.text, "The ordered transcript is ready.")
})

test("a tiny partial token keeps the live thinking state instead of flashing a stalled answer", () => {
  assert.equal(shouldRevealLiveText("I", false), false)
  assert.equal(shouldRevealLiveText("The sub", false), true)
  assert.equal(shouldRevealLiveText("Done.", true), true)
})

test("subagent tools stay beneath the delegated task that ran them", () => {
  const tool = (id, parentId = null) => ({
    kind: "tool",
    id: `tool:${id}`,
    turnId: "turn-1",
    at: "2026-09-03T00:00:01Z",
    call: { id, name: "Bash", input: {}, parent_id: parentId },
    stream: "",
    output: null,
    isError: false,
    complete: true,
  })
  const delegated = tool("agent")
  delegated.call.name = "Agent"
  const childRead = tool("child-read", "agent")
  const nestedAgent = tool("nested-agent", "agent")
  nestedAgent.call.name = "Agent"
  const grandchildSearch = tool("grandchild-search", "nested-agent")
  const rootCommand = tool("root-command")
  const orphan = tool("orphan", "missing-parent")
  const cycleA = tool("cycle-a", "cycle-b")
  const cycleB = tool("cycle-b", "cycle-a")

  const hierarchy = buildWorkHierarchy([
    delegated,
    childRead,
    nestedAgent,
    grandchildSearch,
    rootCommand,
    orphan,
    cycleA,
    cycleB,
  ])

  assert.deepEqual(
    hierarchy.roots.map((block) => block.call.id),
    ["agent", "root-command", "orphan", "cycle-a", "cycle-b"],
  )
  assert.deepEqual(
    hierarchy.childrenByParent.get("agent")?.map((block) => block.call.id),
    ["child-read", "nested-agent"],
  )
  assert.deepEqual(
    hierarchy.childrenByParent.get("nested-agent")?.map((block) => block.call.id),
    ["grandchild-search"],
  )
})
