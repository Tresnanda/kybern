import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import test from "node:test"

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier) && context.parentURL?.includes("/src/"))
      return nextResolve(`${specifier}.ts`, context)
    return nextResolve(specifier, context)
  },
})

const { chunkKey, chunkRuns, chunkWork } = await import("./src/lib/workChunks.ts")

let n = 0
const id = () => `b${++n}`
const tool = (name, input = {}, extra = {}) => ({ kind: "tool", id: id(), turnId: "t", at: "", seq: n, origin: { kind: "root" }, call: { id: `call-${n}`, name, input }, stream: "", output: null, isError: false, complete: true, ...extra })
const launch = (extra) => tool("Task", { description: "Check", prompt: "p" }, extra)
const read = () => tool("Read", { file_path: "/a" })
const thinking = () => ({ kind: "assistant", id: id(), turnId: "t", at: "", seq: n, origin: { kind: "root" }, messageId: "m", segment: 0, text: "", thinking: "hmm", complete: true })
const text = () => ({ ...thinking(), text: "Answer", thinking: "" })
const runtimeAgent = () => ({ kind: "runtime_task", id: id(), turnId: "t", at: "", seq: n, task: { id: `task-${n}`, kind: "agent", status: "running" } })
const none = new Map()
const delegate = (extra) => tool("mcp__kybern__kybern_agent_delegate", { task: "Do it" }, extra)
const shape = (chunks) => chunks.map((chunk) => (chunk.kind === "single" ? "1" : chunk.kind === "tools" ? `T${chunk.blocks.length}` : chunk.kind === "delegations" ? `D${chunk.blocks.length}` : `S${chunk.blocks.length}`)).join(" ")

test("two or more consecutive launches become one subagents chunk", () => {
  assert.equal(shape(chunkWork([launch(), launch(), launch()], none)), "S3")
  assert.equal(shape(chunkWork([launch()], none)), "1", "a single launch is a plain row")
  assert.equal(shape(chunkWork([runtimeAgent(), launch()], none)), "S2", "tool launches and agent runtime tasks group together")
})

test("thinking between launches does not break the group and stays above it", () => {
  const a = launch()
  const think = thinking()
  const b = launch()
  const chunks = chunkWork([a, think, b], none)
  assert.equal(shape(chunks), "1 S2")
  assert.equal(chunks[0].block, think)
  assert.deepEqual(chunks[1].blocks, [a, b])
})

test("thinking after the last launch follows the group", () => {
  const think = thinking()
  const chunks = chunkWork([launch(), launch(), think], none)
  assert.equal(shape(chunks), "S2 1")
  assert.equal(chunks[1].block, think)
})

test("anything else between launches ends the group", () => {
  assert.equal(shape(chunkWork([launch(), read(), launch()], none)), "1 1 1")
  assert.equal(shape(chunkWork([launch(), text(), launch()], none)), "1 1 1")
})

test("settled tool calls still fold into tool groups around a subagent group", () => {
  assert.equal(shape(chunkWork([read(), read(), launch(), launch(), read(), read(), read()], none)), "T2 S2 T3")
})

test("an in-flight tool call does not group, a launch linked to an agent task does", () => {
  const pending = read()
  pending.complete = false
  assert.equal(shape(chunkWork([read(), pending, read()], none)), "1 1 1")
  const generic = tool("Delegate", {})
  const second = tool("Delegate", {})
  const tasks = new Map([[generic.call.id, { kind: "agent", status: "running" }], [second.call.id, { kind: "agent", status: "completed" }]])
  assert.equal(shape(chunkWork([generic, second], tasks)), "S2")
})

test("chunk keys are stable and distinct", () => {
  const a = launch()
  const b = launch()
  assert.equal(chunkKey({ kind: "subagents", blocks: [a, b] }), `subagents:${a.id}`)
  assert.equal(chunkKey({ kind: "single", block: a }), a.id)
  assert.equal(chunkKey({ kind: "tools", blocks: [a, b] }), `group:${a.id}`)
})

test("two or more delegations become one delegations chunk, one stays a plain row", () => {
  assert.equal(shape(chunkWork([delegate(), delegate(), delegate()], none)), "D3")
  assert.equal(shape(chunkWork([delegate()], none)), "1")
  assert.equal(shape(chunkWork([read(), read(), delegate(), delegate(), read()], none)), "T2 D2 1")
})

test("delegations and provider subagents never share a group", () => {
  assert.equal(shape(chunkWork([delegate(), delegate(), launch(), launch()], none)), "D2 S2")
  assert.equal(shape(chunkWork([launch(), delegate()], none)), "1 1")
  assert.equal(shape(chunkWork([launch(), launch(), delegate(), delegate(), delegate()], none)), "S2 D3")
})

test("thinking between delegations stays above the group, and a failed delegation still groups", () => {
  const a = delegate()
  const think = thinking()
  const b = delegate({ isError: true })
  const chunks = chunkWork([a, think, b], none)
  assert.equal(shape(chunks), "1 D2")
  assert.equal(chunks[0].block, think)
  assert.deepEqual(chunks[1].blocks, [a, b])
})

test("only the delegate tool starts a delegation; the other orchestration tools fold like any tool", () => {
  const status = tool("mcp__kybern__kybern_agent_status", {})
  const wait = tool("mcp__kybern__kybern_agent_wait", {})
  assert.equal(shape(chunkWork([status, wait], none)), "T2")
  assert.equal(shape(chunkWork([delegate(), status, delegate()], none)), "1 1 1")
})

test("delegation chunk keys are stable and distinct from subagent groups", () => {
  const a = delegate()
  const b = delegate()
  assert.equal(chunkKey({ kind: "delegations", blocks: [a, b] }), `delegations:${a.id}`)
  assert.notEqual(chunkKey({ kind: "delegations", blocks: [a, b] }), chunkKey({ kind: "subagents", blocks: [a, b] }))
})

test("messages to other threads keep their own rows instead of folding into a tool group", () => {
  const send = (extra) => tool("mcp__kybern__kybern_thread_send", { thread_id: "t", body: "Hi" }, extra)
  assert.equal(shape(chunkWork([read(), send(), send(), read()], none)), "1 1 1 1")
  assert.equal(shape(chunkWork([read(), read(), send()], none)), "T2 1")
})

// ---- chunkRuns: one run per gap between narration ----

const runShape = (chunks) => chunks.map((chunk) => (chunk.kind === "run" ? `R${chunk.blocks.length}` : chunk.kind === "single" ? (chunk.block.kind === "assistant" ? (chunk.block.text ? "P" : "t") : chunk.block.kind[0]) : chunk.kind === "subagents" ? `S${chunk.blocks.length}` : chunk.kind === "delegations" ? `D${chunk.blocks.length}` : `T${chunk.blocks.length}`)).join(" ")
const prose = () => ({ ...thinking(), text: "Narration", thinking: "" })
const thoughtThenProse = () => ({ ...thinking(), text: "Narration", thinking: "hmm" })
const approval = () => ({ kind: "approval", id: id(), turnId: "t", at: "", seq: n, approval: {}, decision: null })
const process = () => ({ kind: "runtime_task", id: id(), turnId: "t", at: "", seq: n, task: { id: `task-${n}`, kind: "process", status: "running" } })

test("every stretch of work between narration is one run, whatever its calls' state", () => {
  const pending = read()
  pending.complete = false
  const failed = read()
  failed.isError = true
  assert.equal(runShape(chunkRuns([read(), tool("Bash", { command: "x" }), thinking(), pending, failed, read()], none)), "R6")
  assert.equal(runShape(chunkRuns([read(), prose(), read(), read(), prose()], none)), "R1 P R2 P")
  assert.equal(runShape(chunkRuns([read()], none)), "R1", "one call is a run too")
})

test("reasoning joins the run; a block with reasoning and text gives its reasoning to the run and stands for its text", () => {
  const mixed = thoughtThenProse()
  const chunks = chunkRuns([read(), mixed, read()], none)
  assert.equal(runShape(chunks), "R2 P R1")
  assert.equal(chunks[0].blocks.at(-1), mixed, "the reasoning is the run's last member")
  assert.equal(chunks[1].block, mixed)
  assert.equal(runShape(chunkRuns([thinking(), read(), thinking(), read()], none)), "R4")
})

test("approvals, mid-turn messages and launches still split runs", () => {
  const user = { kind: "user", id: id(), turnId: "t", at: "", seq: n, message: { parts: [] } }
  assert.equal(runShape(chunkRuns([read(), approval(), read()], none)), "R1 a R1")
  assert.equal(runShape(chunkRuns([read(), user, read()], none)), "R1 u R1")
  assert.equal(runShape(chunkRuns([read(), launch(), launch(), read()], none)), "R1 S2 R1")
  assert.equal(runShape(chunkRuns([read(), delegate(), read()], none)), "R1 t R1")
  const send = tool("mcp__kybern__kybern_thread_send", { thread_id: "x", body: "Hi" })
  assert.equal(runShape(chunkRuns([read(), send, read()], none)), "R1 t R1")
})

test("background processes stay in the run; agent tasks stand as launches", () => {
  assert.equal(runShape(chunkRuns([tool("Bash", { command: "dev" }), process(), read()], none)), "R3")
  assert.equal(runShape(chunkRuns([read(), runtimeAgent(), read()], none)), "R1 r R1")
})

test("a run keeps its key as it grows, and as its first reasoning gains text", () => {
  const think = thinking()
  const blocks = [think]
  const key = chunkKey(chunkRuns(blocks, none)[0])
  assert.equal(key, `group:${think.id}`)
  blocks.push(read(), read())
  assert.equal(chunkKey(chunkRuns(blocks, none)[0]), key)
  blocks[0] = { ...think, text: "Now the answer" }
  const after = chunkRuns(blocks, none)
  assert.equal(runShape(after), "R1 P R2")
  assert.equal(chunkKey(after[0]), key)
  assert.equal(chunkKey(after[1]), think.id, "the narration's key is the block's own, distinct from the run")
})
