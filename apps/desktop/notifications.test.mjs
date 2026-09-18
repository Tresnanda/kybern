import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { registerHooks } from "node:module"
import { fileURLToPath } from "node:url"
import test from "node:test"
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "sonner") return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent("export const toast = Object.assign((title, options) => globalThis.alerts.push({title, ...options}), { error() {}, dismiss() {} });") }
  const url = specifier.startsWith("@/") ? new URL("./src/" + specifier.slice(2), import.meta.url)
    : specifier.startsWith(".") && context.parentURL ? new URL(specifier, context.parentURL) : null
  if (url && !/\.[a-z]+$/i.test(url.pathname) && existsSync(fileURLToPath(url) + ".ts")) return { shortCircuit: true, url: url.href + ".ts" }
  if (url && existsSync(fileURLToPath(url) + "/index.ts")) return { shortCircuit: true, url: url.href + "/index.ts" }
  return next(specifier, context)
}, load(url, context, next) {
  if (url.endsWith("/src/lib/tauri.ts")) return { shortCircuit: true, format: "module", source: "export const isWindowFocused = async () => globalThis.focusProbe(); export const notify = async (title, body) => { globalThis.nativeAlerts.push({ title, body }) };" }
  if (url.endsWith("/src/protocol/client.ts")) return { shortCircuit: true, format: "module", source: `
    export class ConnectionClosedError extends Error {}
    export class RpcCallError extends Error {}
    export class KybernClient {
      status = 'open'; info = null;
      constructor() { globalThis.memoryClient = this }
      onStatus(callback) { this.statusCallback = callback }
      subscribeEvents(params, callback) { this.event = callback }
      connect() { this.statusCallback('open') }
      close() { this.status = 'closed' }
      call(method, params) { return this.reply(method, params) }
    }
  ` }
  return next(url, context)
} })
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
const listeners = new Map()
const eventSurface = {
  addEventListener(type, listener) {
    const current = listeners.get(type) ?? new Set()
    current.add(listener)
    listeners.set(type, current)
  },
  removeEventListener(type, listener) { listeners.get(type)?.delete(listener) },
  dispatchEvent(event) {
    for (const listener of listeners.get(event.type) ?? []) listener(event)
  },
}
globalThis.window = eventSurface
globalThis.document = { ...eventSurface, visibilityState: "visible", hasFocus: () => false }
globalThis.alerts = []
globalThis.nativeAlerts = []
globalThis.focusProbe = () => false
const { createEnvironmentStore } = await import("./src/state/store.ts")
const { createEnvironmentRuntime } = await import("./src/state/rpc.ts")
const { threadAttentionKind } = await import("./src/state/notifications.ts")
const { createSplitView } = await import("./src/state/splitView.ts")
const tick = () => new Promise((resolve) => setImmediate(resolve))

test("completion alerts wait for background waves, recheck native focus races, and deduplicate resumed turns", async () => {
  const store = createEnvironmentStore("notifications")
  store.getState().set({ settings: { notifications: true }, selected: { kind: "none" }, threads: { t: { id: "t", title: "Background work" } } })
  const runtime = createEnvironmentRuntime(store)
  runtime.connect({ url: "ws://fixture", token: "fixture", http_base: "http://fixture" })
  globalThis.memoryClient.reply = () => Promise.resolve({ messages: [], checkpoints: [] })
  let seq = 0
  const send = (payload) => globalThis.memoryClient.event({ seq: ++seq, thread_id: "t", turn_id: "turn", at: new Date(Date.now() + 1000).toISOString(), ...payload })
  const task = (id, status) => ({ id, status, thread_id: "t", origin_turn_id: "turn", kind: "process", title: "Background job", backgrounded: true, started_seq: seq + 1, updated_seq: seq + 1, started_at: new Date().toISOString(), updated_at: new Date().toISOString(), capabilities: {}, stats: {} })
  const complete = { kind: "turn_completed", stop_reason: "completed", duration_ms: 100, usage: {}, terminal_message_id: "final" }
  for (let wave = 1; wave <= 3; wave++) {
    send({ kind: "runtime_task_started", task: { ...task(`task-${wave}`, "running"), kind: wave === 2 ? "agent" : "process" } })
    send(complete)
    await tick()
    assert.equal(globalThis.alerts.length, 0, "provisional foreground result alerted")
    send({ kind: "runtime_task_completed", task: task(`task-${wave}`, "completed") })
    await tick()
    assert.equal(globalThis.alerts.length, 0, "task completion alerted before the agent responded")
  }
  let finishFocus
  globalThis.focusProbe = () => new Promise((resolve) => { finishFocus = resolve })
  send(complete)
  send({ kind: "runtime_task_started", task: task("late-task", "running") })
  finishFocus(false)
  await tick()
  assert.equal(globalThis.alerts.length, 0, "new work during native focus lookup did not suppress stale completion")
  globalThis.focusProbe = () => false
  send({ kind: "runtime_task_completed", task: task("late-task", "completed") })
  send({ kind: "runtime_task_started", task: { ...task("monitor", "running"), kind: "monitor" } })
  send(complete)
  await tick()
  assert.equal(globalThis.alerts.length, 0, "ongoing monitoring announced finished work")
  send({ kind: "runtime_task_completed", task: { ...task("monitor", "completed"), kind: "monitor" } })
  send(complete)
  await tick()
  assert.equal(globalThis.alerts.length, 1)
  assert.equal(globalThis.nativeAlerts.length, 1)
  assert.equal(globalThis.alerts[0].description, "Finished working")
  send({ kind: "turn_resumed" })
  send(complete)
  await tick()
  assert.equal(globalThis.alerts.length, 1, "resumed parent turn repeated its completion alert")
  send({ ...complete, turn_id: "next-turn" })
  await tick()
  assert.equal(globalThis.alerts.length, 2, "next user turn lost its completion alert")
  send({ kind: "turn_failed", turn_id: "failed-turn", error: "Provider exited" })
  await tick()
  assert.equal(globalThis.alerts.at(-1).description, "Failed: Provider exited")
  runtime.disconnect()
})

test("completed threads keep unread dots until their focused foreground pane is actually seen", async () => {
  globalThis.alerts.length = 0
  globalThis.nativeAlerts.length = 0
  globalThis.document.visibilityState = "visible"
  globalThis.focusProbe = () => true

  const thread = (id, title) => ({
    id, title, status: "idle", last_seq: 0,
    project_id: "project", provider: { kind: "codex" },
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  })
  const primary = thread("primary", "Primary")
  const background = thread("background", "Background")
  const splitView = createSplitView({
    sourceThreadId: primary.id,
    threadId: background.id,
    direction: "horizontal",
    side: "second",
  })
  // Keep Primary focused while Background remains mounted in the other pane.
  splitView.focusedPaneId = splitView.root.first.id

  const store = createEnvironmentStore("notification-read-markers")
  store.getState().set({
    settings: { notifications: true },
    selected: { kind: "thread", id: primary.id },
    splitView,
    threads: { [primary.id]: primary, [background.id]: background },
  })
  const runtime = createEnvironmentRuntime(store)
  runtime.connect({ url: "ws://fixture", token: "fixture", http_base: "http://fixture" })
  globalThis.memoryClient.reply = () => Promise.resolve({ messages: [], checkpoints: [] })

  globalThis.memoryClient.event({
    seq: 1,
    thread_id: background.id,
    turn_id: "background-turn",
    at: new Date(Date.now() + 1000).toISOString(),
    kind: "turn_completed",
    stop_reason: "completed",
    duration_ms: 100,
    usage: {},
    terminal_message_id: "final",
  })
  await tick()

  assert.equal(store.getState().notifications[background.id]?.kind, "done")
  assert.equal(
    threadAttentionKind(background, store.getState().notifications[background.id]),
    "done",
    "an inactive completed chat exposes the sidebar unread marker",
  )

  globalThis.document.visibilityState = "hidden"
  store.getState().selectThread(background.id)
  await tick()
  assert.equal(store.getState().notifications[background.id]?.seq, 1, "hidden selection did not consume unread state")

  globalThis.document.visibilityState = "visible"
  globalThis.focusProbe = () => false
  globalThis.document.dispatchEvent({ type: "visibilitychange" })
  await tick()
  assert.equal(store.getState().notifications[background.id]?.seq, 1, "an unfocused window did not consume unread state")

  let finishOldProbe
  globalThis.focusProbe = () => new Promise((resolve) => { finishOldProbe = resolve })
  globalThis.window.dispatchEvent({ type: "focus" })
  await Promise.resolve()
  globalThis.focusProbe = () => false
  store.getState().pushNotification(background.id, "done", 2, new Date(Date.now() + 2000).toISOString())
  finishOldProbe(true)
  await tick()
  assert.equal(store.getState().notifications[background.id]?.seq, 2, "an older focus probe did not clear a newer completion")

  globalThis.focusProbe = () => true
  globalThis.window.dispatchEvent({ type: "focus" })
  await tick()
  assert.equal(store.getState().notifications[background.id], undefined, "the focused foreground chat was marked read without another click")

  runtime.disconnect()
})

test("read tracking survives a runtime reconnect without consuming inactive unread threads", async () => {
  globalThis.document.visibilityState = "visible"
  globalThis.focusProbe = () => true
  const store = createEnvironmentStore("notification-reconnect")
  store.getState().set({ selected: { kind: "thread", id: "active" } })
  store.getState().pushNotification("inactive", "done", 4, new Date().toISOString())

  const first = createEnvironmentRuntime(store)
  await tick()
  first.disconnect()
  const second = createEnvironmentRuntime(store)
  await tick()

  assert.equal(store.getState().notifications.inactive?.seq, 4)
  store.getState().selectThread("inactive")
  await tick()
  assert.equal(store.getState().notifications.inactive, undefined)
  second.disconnect()
})
