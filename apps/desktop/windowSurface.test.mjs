import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { registerHooks } from "node:module"
import { fileURLToPath } from "node:url"
import test from "node:test"

registerHooks({
  resolve(specifier, context, next) {
    const url = specifier.startsWith("@/") ? new URL("./src/" + specifier.slice(2), import.meta.url)
      : specifier.startsWith(".") && context.parentURL ? new URL(specifier, context.parentURL) : null
    if (url && !/\.[a-z]+$/i.test(url.pathname) && existsSync(fileURLToPath(url) + ".ts")) return { shortCircuit: true, url: url.href + ".ts" }
    if (url && existsSync(fileURLToPath(url) + "/index.ts")) return { shortCircuit: true, url: url.href + "/index.ts" }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.endsWith("/src/lib/tauri.ts")) return { shortCircuit: true, format: "module", source: "export const isWindowFocused = async () => true; export const notify = async () => {}; export const isTauri = () => false;" }
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
  },
})
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }

const { activateEnvironmentStore, isThreadVisible, collectOpenThreadIds } = await import("./src/state/store.ts")
const { emptyThreadState } = await import("./src/state/transcript.ts")
const { createRetentionPolicy } = await import("./src/state/retention.ts")
const {
  applyWindowSurface,
  flushHiddenWindowCompact,
  resetHiddenWindowCompact,
  isWindowOnScreen,
  windowHoldsTranscript,
  registerTranscriptAnchor,
  peekTranscriptAnchor,
} = await import("./src/state/windowSurface.ts")

const history = (text) => ({
  ...emptyThreadState(),
  loaded: true,
  pendingApprovals: [{ id: "approval" }],
  pendingQuestions: [{ id: "question" }],
  lastSeq: 4,
  blocks: [{ kind: "assistant", id: "m#0", messageId: "m", turnId: "turn", text, thinking: "", complete: false, segment: 0, origin: { kind: "root" } }],
})

function seed(id) {
  const store = activateEnvironmentStore(id)
  store.getState().set({
    selected: { kind: "thread", id: "t" },
    transcripts: { t: history("x".repeat(8000)) },
    composerDrafts: { "thread:t": { text: "draft", attachments: [{ id: "a", name: "note.md", media_type: "text/markdown", size: 4 }], mentions: [], skills: [] } },
    queued: { t: [{ id: "q", message: { parts: [{ type: "text", text: "queued" }] } }] },
    terminalTabs: { t: [{ key: "pty", title: "Shell", command: null }] },
    activeTerminalTab: { t: "pty" },
    diffs: { "t:all": { patch: "large" } },
  })
  return store
}

test("blur without occlusion keeps the open transcript mounted", () => {
  resetHiddenWindowCompact()
  const store = seed("blur-visible")
  applyWindowSurface({ occluded: false, minimized: false, focused: false })
  flushHiddenWindowCompact()
  assert.equal(isWindowOnScreen(), true)
  assert.equal(windowHoldsTranscript(), true)
  assert.equal(isThreadVisible(store.getState(), "t"), true)
  assert.equal(store.getState().transcripts.t.loaded, true)
  assert.equal(store.getState().transcripts.t.blocks.length, 1)
  resetHiddenWindowCompact()
})

test("occluded and minimized windows compact reconstructible transcript and keep pending user data", () => {
  resetHiddenWindowCompact()
  const store = seed("hidden-compact")
  let captured = false
  const stop = registerTranscriptAnchor("t", () => {
    captured = true
    return { following: false, messageId: "m#0", turnId: "turn", seq: 4 }
  })
  applyWindowSurface({ occluded: true, minimized: false, focused: true })
  assert.equal(isWindowOnScreen(), false)
  assert.equal(store.getState().transcripts.t.loaded, true, "delay leaves the live transcript mounted")
  flushHiddenWindowCompact()
  assert.equal(captured, true)
  assert.equal(windowHoldsTranscript(), false)
  assert.equal(isThreadVisible(store.getState(), "t"), false)
  const state = store.getState()
  assert.equal(state.transcripts.t.loaded, false)
  assert.equal(state.transcripts.t.blocks.length, 0)
  assert.equal(state.transcripts.t.lastSeq, 4)
  assert.deepEqual(state.transcripts.t.pendingApprovals, [{ id: "approval" }])
  assert.equal(state.transcripts.t.pendingQuestions[0].id, "question")
  assert.equal(state.composerDrafts["thread:t"].text, "draft")
  assert.equal(state.composerDrafts["thread:t"].attachments[0].id, "a")
  assert.equal(state.queued.t[0].id, "q")
  assert.equal(state.terminalTabs.t[0].key, "pty")
  assert.equal(state.activeTerminalTab.t, "pty")
  assert.deepEqual(state.diffs, {})
  assert.deepEqual(peekTranscriptAnchor("t"), { following: false, messageId: "m#0", turnId: "turn", seq: 4 })
  stop()

  applyWindowSurface({ occluded: false, minimized: false, focused: true })
  assert.equal(isWindowOnScreen(), true)
  assert.equal(windowHoldsTranscript(), true)
  assert.equal(isThreadVisible(store.getState(), "t"), true)
  resetHiddenWindowCompact()
})

test("minimized windows compact even while still focused", () => {
  resetHiddenWindowCompact()
  const store = seed("minimized-compact")
  applyWindowSurface({ occluded: false, minimized: true, focused: true })
  flushHiddenWindowCompact()
  assert.equal(store.getState().transcripts.t.loaded, false)
  resetHiddenWindowCompact()
})

test("page visibility (WebKit occlusion) compacts without treating focus as hidden", () => {
  resetHiddenWindowCompact()
  const store = seed("page-hidden")
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document")
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      hidden: true,
      hasFocus: () => true,
      addEventListener() {},
      removeEventListener() {},
      querySelector() { return null },
      activeElement: null,
      getElementsByTagName() { return [] },
    },
  })
  try {
    applyWindowSurface({ focused: true })
    flushHiddenWindowCompact()
    assert.equal(isWindowOnScreen(), false)
    assert.equal(store.getState().transcripts.t.loaded, false)
    document.hidden = false
    applyWindowSurface({ focused: false })
    assert.equal(isWindowOnScreen(), true, "unfocused but visible windows stay on screen")
    assert.equal(windowHoldsTranscript(), true)
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous)
    else delete globalThis.document
    resetHiddenWindowCompact()
  }
})

test("hidden-window compaction matches inactive-thread eviction for pending user data", () => {
  resetHiddenWindowCompact()
  const store = seed("hidden-retention")
  applyWindowSurface({ occluded: true, minimized: false, focused: false })
  flushHiddenWindowCompact()
  const after = store.getState()
  const patch = createRetentionPolicy(1)(after, after)
  assert.equal(patch, null)
  assert.equal(after.composerDrafts["thread:t"].text, "draft")
  assert.equal(after.queued.t[0].id, "q")
  resetHiddenWindowCompact()
  const visible = seed("visible-retention")
  const ids = collectOpenThreadIds(visible.getState())
  assert.deepEqual(ids, ["t"])
  const keep = createRetentionPolicy(1)(visible.getState(), visible.getState())
  assert.equal(keep?.transcripts?.t ?? visible.getState().transcripts.t, visible.getState().transcripts.t)
})

test("showing a compacted window asks the runtime to rehydrate open threads", async () => {
  resetHiddenWindowCompact()
  const { createEnvironmentRuntime, setEnvironmentRuntime } = await import("./src/state/rpc.ts")
  const store = seed("restore-load")
  const runtime = createEnvironmentRuntime(store)
  setEnvironmentRuntime(runtime)
  runtime.connect({ url: "ws://fixture", token: "fixture", http_base: "http://fixture" })
  const client = globalThis.memoryClient
  let gets = 0
  client.reply = async (method) => {
    if (method === "threads.get") {
      gets++
      return {
        thread: { id: "t", last_seq: 4, project_id: "p", status: "idle" },
        transcript: [{ role: "assistant", id: "m", turn_id: "turn", text: "restored", thinking: "", complete: false, seq: 4 }],
        pending_approvals: [{ id: "approval" }],
        pending_questions: [{ id: "question" }],
      }
    }
    if (method === "threads.list") return { threads: [{ id: "t", project_id: "p", status: "idle", last_seq: 4 }] }
    if (method === "projects.list") return { projects: [{ id: "p" }] }
    if (method === "providers.list") return { providers: [] }
    if (method === "queue.list") return { messages: [] }
    return { checkpoints: [] }
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve))
  try {
    client.subscribed?.(10, { resumed: false, supported: true })
    await settle()
    gets = 0
    applyWindowSurface({ occluded: true, minimized: false, focused: true })
    flushHiddenWindowCompact()
    assert.equal(store.getState().transcripts.t.loaded, false)
    applyWindowSurface({ occluded: false, minimized: false, focused: true })
    await settle()
    await settle()
    await settle()
    assert.ok(gets >= 1, "restore hydrates the open thread")
    assert.equal(store.getState().transcripts.t.loaded, true)
    assert.equal(store.getState().transcripts.t.blocks[0].text, "restored")
    assert.equal(store.getState().transcripts.t.pendingApprovals[0].id, "approval")
    assert.equal(store.getState().composerDrafts["thread:t"].text, "draft")
  } finally {
    runtime.disconnect()
    setEnvironmentRuntime(null)
    resetHiddenWindowCompact()
  }
})
