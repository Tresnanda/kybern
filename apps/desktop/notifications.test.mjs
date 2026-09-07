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
globalThis.document = { hasFocus: () => false }
globalThis.alerts = []
globalThis.nativeAlerts = []
globalThis.focusProbe = () => false
const { createEnvironmentStore } = await import("./src/state/store.ts")
const { createEnvironmentRuntime } = await import("./src/state/rpc.ts")
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
