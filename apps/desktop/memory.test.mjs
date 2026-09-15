import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { registerHooks } from "node:module"
import { fileURLToPath } from "node:url"
import test from "node:test"
registerHooks({ resolve(specifier, context, next) {
  const url = specifier.startsWith("@/") ? new URL("./src/" + specifier.slice(2), import.meta.url)
    : specifier.startsWith(".") && context.parentURL ? new URL(specifier, context.parentURL) : null
  if (url && !/\.[a-z]+$/i.test(url.pathname) && existsSync(fileURLToPath(url) + ".ts")) return { shortCircuit: true, url: url.href + ".ts" }
  if (url && existsSync(fileURLToPath(url) + "/index.ts")) return { shortCircuit: true, url: url.href + "/index.ts" }
  return next(specifier, context)
}, load(url, context, next) {
  if (url.endsWith("/src/lib/tauri.ts")) return { shortCircuit: true, format: "module", source: "export const isWindowFocused = async () => true; export const notify = async () => {};" }
  if (url.endsWith("/src/protocol/client.ts")) return { shortCircuit: true, format: "module", source: `
    export class ConnectionClosedError extends Error {}
    export class RpcCallError extends Error {}
    export class KybernClient {
      status = 'open'; info = null;
      constructor() { globalThis.memoryClient = this }
      onStatus(callback) { this.statusCallback = callback }
      subscribeEvents(params, callback, subscribed, ready) { this.event = callback; this.subscribed = subscribed; this.ready = ready }
      connect() { this.statusCallback('open') }
      close() { this.status = 'closed' }
      call(method, params) { return this.reply(method, params) }
    }
  ` }
  return next(url, context)
} })
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
const { createEnvironmentStore, activateEnvironmentStore } = await import("./src/state/store.ts")
const { emptyThreadState, applyBackgroundEvent, applyEvent, seedFromGet } = await import("./src/state/transcript.ts")
const { createRetentionPolicy } = await import("./src/state/retention.ts")
const { createSnapshotReplay } = await import("./src/state/snapshotReplay.ts")
const { createIdleRelease } = await import("./src/lib/idleRelease.ts")
const event = (seq, payload) => ({ seq, thread_id: "t", turn_id: "turn", at: "2026-09-07T00:00:00Z", ...payload })
const history = (text) => ({ ...emptyThreadState(), loaded: true, blocks: [{ kind: "assistant", id: "m#0", messageId: "m", turnId: "turn", text, thinking: "", complete: false, segment: 0, origin: { kind: "root" } }] })

test("background payloads are discarded while approval controls and sequence remain", () => {
  const approval = { id: "a", input: { command: "review me" } }
  let state = history("old history")
  state = applyBackgroundEvent(state, event(1, { kind: "approval_requested", approval }))
  for (let seq = 2; seq < 100; seq++) state = applyBackgroundEvent(state, event(seq, { kind: "assistant_text_delta", message_id: "m", delta: "x".repeat(8192) }))
  assert.equal(state.blocks.length, 0)
  assert.equal(state.loaded, false)
  assert.equal(state.lastSeq, 99)
  assert.deepEqual(state.pendingApprovals, [approval])
  state = applyBackgroundEvent(state, event(100, { kind: "approval_resolved", approval_id: "a", decision: "allow" }))
  assert.deepEqual(state.pendingApprovals, [])
})

test("hydrated history keeps large tool results out of retained state until fetched", async () => {
  const { retainedSize } = await import("./src/lib/retainedSize.ts")
  const large = "x".repeat(200_000)
  const at = "2026-09-07T00:00:00Z"
  const call = { id: "c", name: "bash", input: {} }
  const full = seedFromGet({
    thread: { id: "t", last_seq: 1 },
    transcript: [{ role: "tool_call", turn_id: "turn", seq: 1, origin: { kind: "root" }, call, output: large, is_error: false, complete: true, at }],
    pending_approvals: [],
  })
  const omitted = seedFromGet({
    thread: { id: "t", last_seq: 1 },
    transcript: [{ role: "tool_call", turn_id: "turn", seq: 1, origin: { kind: "root" }, call, output_omitted: true, is_error: false, complete: true, at }],
    pending_approvals: [],
  })
  assert.equal(omitted.blocks[0].outputOmitted, true)
  assert.equal(omitted.blocks[0].output, null)
  assert.ok(retainedSize(full.blocks) > retainedSize(omitted.blocks) * 20)
})

test("hydrateToolOutput is a no-op without a connected runtime", async () => {
  const { hydrateToolOutput } = await import("./src/state/rpc.ts")
  await hydrateToolOutput("t", "c")
})
test("hydrateToolOutput skips inlined tool results", async () => {
  const { createEnvironmentRuntime } = await import("./src/state/rpc.ts")
  const store = createEnvironmentStore("inlined-tool-output")
  const runtime = createEnvironmentRuntime(store)
  runtime.connect({ url: "ws://fixture", token: "fixture", http_base: "http://fixture" })
  const client = globalThis.memoryClient
  client.reply = async () => { throw new Error("should not fetch inlined tool output") }
  store.getState().updateTranscript("t", () => seedFromGet({
    thread: { id: "t", last_seq: 1 },
    transcript: [{ role: "tool_call", turn_id: "turn", seq: 1, origin: { kind: "root" }, call: { id: "c", name: "Task", input: { prompt: "Inspect" } }, output: "The agent finished reviewing.", is_error: false, complete: true, at: "2026-09-07T00:00:00Z" }],
    pending_approvals: [],
  }))
  try {
    await runtime.hydrateToolOutput("t", "c")
    assert.equal(store.getState().transcripts.t.blocks[0].output, "The agent finished reviewing.")
  } finally { runtime.disconnect() }
})
test("expanding an omitted tool result fetches only that payload", async () => {
  const { createEnvironmentRuntime } = await import("./src/state/rpc.ts")
  const store = createEnvironmentStore("tool-output")
  const runtime = createEnvironmentRuntime(store)
  runtime.connect({ url: "ws://fixture", token: "fixture", http_base: "http://fixture" })
  const client = globalThis.memoryClient
  let fetched
  client.reply = async (method, params) => {
    if (method === "threads.tool_output") {
      fetched = params
      return { output: "full result", is_error: false }
    }
    return { checkpoints: [] }
  }
  store.getState().updateTranscript("t", () => seedFromGet({
    thread: { id: "t", last_seq: 1 },
    transcript: [{ role: "tool_call", turn_id: "turn", seq: 1, origin: { kind: "root" }, call: { id: "c", name: "bash", input: {} }, output_omitted: true, is_error: false, complete: true, at: "2026-09-07T00:00:00Z" }],
    pending_approvals: [],
  }))
  try {
    await runtime.hydrateToolOutput("t", "c")
    assert.deepEqual(fetched, { thread_id: "t", tool_call_id: "c" })
    const block = store.getState().transcripts.t.blocks[0]
    assert.equal(block.output, "full result")
    assert.equal(block.outputOmitted, false)
  } finally { runtime.disconnect() }
})
test("inactive cache eviction preserves visible split panes and pending user data", () => {
  const store = createEnvironmentStore("retention")
  const a = history("a".repeat(4000)), b = history("b".repeat(4000)), c = history("c".repeat(4000))
  b.pendingApprovals = [{ id: "approval" }]
  store.getState().set({ selected: { kind: "thread", id: "a" }, transcripts: { a, b, c }, composerDrafts: { a: { text: "keep draft" } }, queued: { a: [{ id: "q" }] }, terminalTabs: { a: [{ key: "pty" }] } })
  const before = store.getState()
  const patch = createRetentionPolicy(10_000)(before, before)
  assert(patch)
  assert.equal(patch.transcripts.a, a)
  assert.equal(patch.transcripts.b.loaded, false)
  assert.deepEqual(patch.transcripts.b.pendingApprovals, [{ id: "approval" }])
  store.getState().set(patch)
  assert.equal(store.getState().composerDrafts.a.text, "keep draft")
  assert.equal(store.getState().queued.a[0].id, "q")
  assert.equal(store.getState().terminalTabs.a[0].key, "pty")
  store.getState().openThreadInSplit("c", "horizontal")
  const split = store.getState()
  const trimmed = createRetentionPolicy(1)(split, split)
  assert.equal(trimmed?.transcripts.a ?? split.transcripts.a, a)
  assert.equal(trimmed?.transcripts.c ?? split.transcripts.c, c)
})

test("environment changes release heavy caches and retain drafts and pending questions", () => {
  const a = activateEnvironmentStore("release-a")
  a.getState().set({ transcripts: { t: { ...history("large"), pendingQuestions: [{ id: "question" }] } }, diffs: { "t:all": { patch: "large patch" } }, composerDrafts: { t: { text: "draft" } } })
  activateEnvironmentStore("release-b")
  assert.equal(a.getState().transcripts.t.blocks.length, 0)
  assert.equal(a.getState().transcripts.t.loaded, false)
  assert.equal(a.getState().transcripts.t.pendingQuestions[0].id, "question")
  assert.deepEqual(a.getState().diffs, {})
  assert.equal(activateEnvironmentStore("release-a").getState().composerDrafts.t.text, "draft")
})

test("snapshot replay retains events newer than the snapshot and detects overflow", () => {
  const buffer = createSnapshotReplay()
  buffer.add(event(11, { kind: "assistant_text_delta", message_id: "m", delta: " world" }))
  buffer.add(event(12, { kind: "approval_requested", approval: { id: "a" } }))
  const snapshot = { thread: { id: "t", last_seq: 10 }, transcript: [{ role: "assistant", id: "m", turn_id: "turn", text: "hello", thinking: "", complete: false, seq: 10 }], pending_approvals: [] }
  let state = seedFromGet(snapshot)
  for (const event of buffer.after(10)) state = applyEvent(state, event)
  assert.equal(state.blocks[0].text, "hello world")
  assert.equal(state.pendingApprovals[0].id, "a")
  assert.equal(state.lastSeq, 12)
  const small = createSnapshotReplay(10)
  small.add(event(13, { kind: "assistant_text_delta", delta: "large" }))
  assert.equal(small.after(12), null)
  assert.deepEqual(small.after(13), [])
})

test("idle resources release only without active work and can be reused", async () => {
  let idle = false, releases = 0
  const resource = createIdleRelease(() => idle, () => releases++, 10)
  resource.settle()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(releases, 0)
  idle = true; resource.settle(); resource.touch()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(releases, 0)
  resource.settle()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(releases, 1)
  resource.settle(); resource.dispose()
})


test("runtime snapshot replay survives live deltas, navigation, and disconnect during load", async () => {
  const { createEnvironmentRuntime } = await import("./src/state/rpc.ts")
  const store = createEnvironmentStore("snapshot-runtime")
  store.getState().set({ selected: { kind: "thread", id: "t" } })
  const runtime = createEnvironmentRuntime(store)
  runtime.connect({ url: "ws://fixture", token: "fixture", http_base: "http://fixture" })
  let finish
  globalThis.memoryClient.reply = (method) => method === "threads.get" ? new Promise(resolve => { finish = resolve }) : Promise.resolve({ checkpoints: [] })
  const snapshot = (seq) => ({ thread: { id: "t", last_seq: seq }, transcript: [{ role: "assistant", id: "m", turn_id: "turn", text: "hello", thinking: "", complete: false, seq }], pending_approvals: [] })
  let pending = runtime.loadThread("t")
  globalThis.memoryClient.event(event(11, { kind: "assistant_text_delta", message_id: "m", delta: " world" }))
  finish(snapshot(10)); await pending
  assert.equal(store.getState().transcripts.t.blocks[0].text, "hello world")
  assert.equal(store.getState().transcripts.t.lastSeq, 11)
  pending = runtime.loadThread("t")
  store.getState().set({ selected: { kind: "thread", id: "other" } })
  finish(snapshot(11)); await pending
  assert.equal(store.getState().transcripts.t.loaded, false)
  assert.equal(store.getState().transcripts.t.blocks.length, 0)
  store.getState().set({ selected: { kind: "thread", id: "t" } })
  pending = runtime.loadThread("t")
  runtime.disconnect()
  finish(snapshot(11)); await pending
  assert.equal(store.getState().transcripts.t.loaded, false)
  assert.equal(store.getState().transcripts.t.blocks.length, 0)
})


test("desktop reopen and completed reconnect replay reuse cached content; legacy hosts refresh", async () => {
  const { createEnvironmentRuntime } = await import("./src/state/rpc.ts")
  const store = createEnvironmentStore("reconnect-runtime")
  store.getState().set({ selected: { kind: "thread", id: "t" } })
  const runtime = createEnvironmentRuntime(store)
  runtime.connect({ url: "ws://fixture", token: "fixture", http_base: "http://fixture" })
  const client = globalThis.memoryClient
  let downloads = 0, head = 10
  const thread = () => ({ id: "t", project_id: "p", status: "idle", last_seq: head })
  client.reply = async (method) => {
    if (method === "threads.get") {
      downloads++
      return { thread: thread(), transcript: [{ role: "assistant", id: "m", turn_id: "turn", text: "hello", thinking: "", complete: false, seq: 10 }], pending_approvals: [] }
    }
    if (method === "threads.list") return { threads: [thread()] }
    if (method === "projects.list") return { projects: [{ id: "p" }] }
    if (method === "providers.list") return { providers: [] }
    if (method === "queue.list") return { messages: [] }
    return { checkpoints: [] }
  }
  const settle = () => new Promise(resolve => setImmediate(resolve))
  client.subscribed(10, { resumed: false, supported: true }); await settle()
  assert.equal(downloads, 1)
  await runtime.loadThread("t")
  assert.equal(downloads, 1, "reopen does not download an unchanged thread")
  store.getState().set({ selected: { kind: "none" } })
  client.event(event(++head, { kind: "assistant_text_delta", message_id: "m", delta: " while closed" }))
  store.getState().set({ selected: { kind: "thread", id: "t" } })
  await runtime.loadThread("t")
  assert.equal(downloads, 1)
  assert.equal(store.getState().transcripts.t.blocks[0].text, "hello while closed")
  client.status = "reconnecting"; client.statusCallback("reconnecting")
  client.status = "open"; client.statusCallback("open")
  client.subscribed(12, { resumed: true, supported: true }); await settle()
  assert.equal(downloads, 1)
  client.event(event(++head, { kind: "assistant_text_delta", message_id: "m", delta: " after reconnect" }))
  const before = store.getState().transcripts.t.blocks
  client.ready(head, true); await settle()
  assert.equal(downloads, 1)
  assert.equal(store.getState().transcripts.t.blocks, before)
  assert.equal(before[0].text, "hello while closed after reconnect")
  client.subscribed(head, { resumed: true, supported: false }); await settle()
  assert.equal(downloads, 2, "older hosts retain snapshot fallback")
  runtime.disconnect()
})


test("desktop history paging freezes the sequence and preserves live text and row identities", async () => {
  const { createEnvironmentRuntime } = await import("./src/state/rpc.ts")
  const store = createEnvironmentStore("history-runtime")
  store.getState().set({ selected: { kind: "thread", id: "t" } })
  const runtime = createEnvironmentRuntime(store)
  runtime.connect({ url: "ws://fixture", token: "fixture", http_base: "http://fixture" })
  const client = globalThis.memoryClient
  let requested, finish
  client.reply = (method, params) => {
    if (method !== "threads.get") return Promise.resolve({ checkpoints: [] })
    requested = params
    if (params.before_seq) return new Promise(resolve => { finish = resolve })
    return Promise.resolve({ thread: { id: "t", last_seq: 10 }, next_before_seq: 10, transcript: [{ role: "assistant", id: "m", turn_id: "turn", text: "Hello", complete: false, seq: 10 }], pending_approvals: [] })
  }
  await runtime.loadThread("t")
  assert.equal(requested.transcript_limit, 60)
  const pending = runtime.loadEarlier("t")
  assert.equal(runtime.loadEarlier("t"), pending)
  assert.equal(requested.transcript_limit, 120)
  assert.equal(requested.before_seq, 10)
  assert.equal(requested.through_seq, 10)
  client.event(event(11, { kind: "assistant_text_delta", message_id: "m", delta: " world" }))
  const live = store.getState().transcripts.t.blocks[0]
  finish({ thread: { id: "t", last_seq: 10 }, transcript: [{ role: "user", id: "u", turn_id: "turn", seq: 1, message: { parts: [{ type: "text", text: "Earlier prompt" }] } }], pending_approvals: [] })
  await pending
  const current = store.getState().transcripts.t
  assert.equal(current.nextBeforeSeq, null)
  assert.equal(current.loadingEarlier, false)
  assert.equal(current.blocks[0].kind, "user")
  assert.equal(current.blocks[1], live)
  assert.equal(current.blocks[1].text, "Hello world")
  runtime.disconnect()
})


test("refresh of a large loaded history stays paged and replays concurrent output", async () => {
  const { createEnvironmentRuntime } = await import("./src/state/rpc.ts")
  const store = createEnvironmentStore("large-refresh")
  store.getState().set({ selected: { kind: "thread", id: "t" } })
  const runtime = createEnvironmentRuntime(store)
  runtime.connect({ url: "ws://fixture", token: "fixture", http_base: "http://fixture" })
  const client = globalThis.memoryClient
  const all = Array.from({ length: 2000 }, (_, i) => ({ role: "assistant", id: `m${i}`, turn_id: `turn${i}`, text: `Reply ${i}`, thinking: "", complete: i !== 1400 && i !== 1999, seq: i + 1 }))
  const snapshot = { thread: { id: "t", last_seq: 2000 }, transcript: all.slice(-650), next_before_seq: 1351, pending_approvals: [] }
  store.getState().updateTranscript("t", () => seedFromGet(snapshot))
  const requests = []
  client.reply = async (method, params) => {
    if (method !== "threads.get") return { checkpoints: [] }
    requests.push(params)
    assert.ok(params.transcript_limit > 0 && params.transcript_limit <= 500, "every refresh request must be bounded")
    assert.equal(params.include_tool_output, false)
    if (requests.length === 2) {
      assert.equal(params.through_seq, 2000)
      client.event(event(2001, { kind: "assistant_text_delta", message_id: "m1999", delta: " live" }))
    }
    const eligible = all.filter(row => !params.before_seq || row.seq < params.before_seq)
    const page = eligible.slice(-params.transcript_limit)
    const unfinished = params.before_seq ? [] : all.filter(row => !row.complete && row.seq < page[0].seq)
    return { ...snapshot, transcript: [...unfinished, ...page], next_before_seq: page[0].seq > 1 ? page[0].seq : null }
  }
  try {
    await runtime.loadThread("t", true)
    assert.equal(requests.length, 2)
    const result = store.getState().transcripts.t
    assert.equal(result.blocks.length, 650)
    assert.equal(result.blocks[0].seq, 1351)
    assert.equal(result.blocks.at(-1).text, "Reply 1999 live")
    assert.equal(result.nextBeforeSeq, 1351)
    assert.equal(result.lastSeq, 2001)
  } finally { runtime.disconnect() }
})


test("terminal graphics release without disposing buffers and ignore stale addon loads", async () => {
  const { createTerminalRenderer } = await import("./src/lib/terminalRenderer.ts")
  const pending = [], addons = []
  let loads = 0, disposals = 0
  class WebglAddon {
    constructor() { addons.push(this) }
    onContextLoss(callback) { this.lost = callback }
    dispose() { disposals++ }
  }
  const terminal = { options: {}, rows: 24, loadAddon() { loads++ }, refresh() {} }
  const resource = createTerminalRenderer(terminal, () => new Promise(resolve => pending.push(() => resolve({ WebglAddon }))))
  const settle = () => new Promise(resolve => setImmediate(resolve))
  resource.setActive(true)
  resource.setActive(false)
  pending.shift()(); await settle()
  assert.equal(loads, 0, "a hidden tab must not acquire a late GPU context")
  resource.setActive(true)
  pending.shift()(); await settle()
  assert.equal(loads, 1)
  assert.equal(terminal.options.cursorBlink, true)
  resource.setActive(false)
  assert.equal(disposals, 1)
  assert.equal(terminal.options.cursorBlink, false)
  resource.setActive(true)
  pending.shift()(); await settle()
  assert.equal(loads, 2)
  addons.at(-1).lost()
  assert.equal(disposals, 2)
  resource.setActive(false); resource.setActive(true)
  resource.dispose()
  pending.shift()(); await settle()
  assert.equal(loads, 2)
  assert.equal(disposals, 2)
})


test("collapsed output availability exactly matches readable result text", async () => {
  const { outputText, hasOutputText } = await import("./src/lib/format.ts")
  const { surfaceOutputText, surfaceHasOutputText } = await import("./src/lib/toolSurface.ts")
  const values = [null, false, 0, "", "  ", "result", [], {}, { stdout: " ", text: "unused" }, { type: "imageGeneration", result: "" }, { output: "data:image/png;base64,YQ==" }, { content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] }, { error: " " }, { error: { message: "failed" } }]
  for (const output of values) for (const stream of ["", " ", "live output"]) {
    assert.equal(hasOutputText(output, stream), outputText(output, stream).trim().length > 0)
    assert.equal(surfaceHasOutputText(output), surfaceOutputText(output).trim().length > 0)
  }
})


test("following history releases only whole old turns and keeps a reload cursor and row identities", async () => {
  const { trimFollowingHistory } = await import("./src/state/followingHistory.ts")
  const blocks = Array.from({ length: 2000 }, (_, i) => ({ kind: "assistant", id: `m${i}`, messageId: `m${i}`, turnId: `turn${Math.floor(i / 2)}`, text: "reply", thinking: "", complete: true, seq: i + 1 }))
  const state = { ...emptyThreadState(), loaded: true, blocks, lastSeq: 2000, pendingQuestions: [{ id: "keep" }] }
  const trimmed = trimFollowingHistory(state)
  assert.equal(trimmed.blocks.length, 600)
  assert.equal(trimmed.blocks[0], blocks[1400])
  assert.equal(trimmed.blocks.at(-1), blocks.at(-1))
  assert.equal(trimmed.nextBeforeSeq, 1401)
  assert.equal(trimmed.lastSeq, 2000)
  assert.equal(trimmed.pendingQuestions, state.pendingQuestions)
  assert.equal(trimFollowingHistory(trimmed), trimmed, "hysteresis avoids trimming every update")
  const loading = { ...state, loadingEarlier: true }
  assert.equal(trimFollowingHistory(loading), loading)
  const live = { ...state, blocks: blocks.map((block, i) => i === 1 ? { ...block, complete: false } : block) }
  assert.equal(trimFollowingHistory(live), live, "unfinished old work pins its whole turn")
  const large = { ...state, blocks: blocks.slice(-20).map(block => ({ ...block, text: "x".repeat(1024 * 1024) })) }
  const bounded = trimFollowingHistory(large)
  assert.ok(bounded.blocks.length < 20 && bounded.blocks.length >= 4)
  assert.equal(bounded.blocks.at(-1), large.blocks.at(-1))
})


test("following-history cutoffs never split interleaved turns around pinned work", async () => {
  const { trimFollowingHistory } = await import("./src/state/followingHistory.ts")
  const blocks = Array.from({ length: 2000 }, (_, i) => ({ kind: "assistant", id: `m${i}`, messageId: `m${i}`, turnId: `turn${i}`, text: "reply", thinking: "", complete: true, seq: i + 1 }))
  blocks[1000] = { ...blocks[1000], complete: false }
  blocks[1100] = { ...blocks[1100], turnId: blocks[900].turnId }
  const trimmed = trimFollowingHistory({ ...emptyThreadState(), loaded: true, blocks })
  assert.equal(trimmed.blocks[0], blocks[900])
  for (const block of trimmed.blocks) {
    assert.equal(trimmed.blocks.filter(row => row.turnId === block.turnId).length, blocks.filter(row => row.turnId === block.turnId).length)
  }
})
