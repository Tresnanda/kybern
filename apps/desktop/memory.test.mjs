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
