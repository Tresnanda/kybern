import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PROTOCOL_VERSION } from "../../../packages/kybern-client/src/types.ts";
const saved = JSON.stringify({ environments: [{ id: "host", name: "Test host", url: "ws://localhost/ws", token: "fixture", environmentId: "host" }], activeId: "host" });
globalThis.reconnectSaved = saved;
const unsubscribers = [];
globalThis.reconnectSubscribe = (subscribe, getSnapshot) => {
  unsubscribers.push(subscribe(() => {}));
  return getSnapshot();
};
registerHooks({ resolve(specifier, context, next) {
  const source = specifier === "react-native"
    ? 'export const Platform = { OS: "android" }; export const AppState = { addEventListener() {} };'
    : specifier === "expo-secure-store"
      ? 'export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = "test"; export async function setItemAsync() {} export async function getItemAsync() { return globalThis.reconnectSaved; }'
      : specifier === "react"
        ? 'export const useCallback = fn => fn; export const useEffect = () => {}; export const useSyncExternalStore = (...args) => globalThis.reconnectSubscribe(...args);'
        : null;
  if (source) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` };
  const url = specifier.startsWith(".") && context.parentURL ? new URL(specifier, context.parentURL) : null;
  if (url?.protocol === "file:" && !/\.[a-z]+$/i.test(url.pathname) && existsSync(fileURLToPath(url) + ".ts")) return { shortCircuit: true, url: url.href + ".ts" };
  return next(specifier, context);
} });
const runtime = await import("../src/state/runtime.ts");
const sockets = [];
let downloads = 0, head = 10;
const thread = () => ({ id: "thread", project_id: "project", last_seq: head, status: "running" });
class Socket {
  readyState = 0; sent = [];
  constructor() { sockets.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; }
  interrupt() { this.close(); this.onclose?.({ code: 1006 }); }
  frame(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  reply(request, result) { this.frame({ jsonrpc: "2.0", id: request.id, result }); }
  send(text) {
    const request = JSON.parse(text); this.sent.push(request);
    let result;
    switch (request.method) {
      case "daemon.info": result = { protocol_version: PROTOCOL_VERSION, environment_id: "host" }; break;
      case "events.subscribe": case "providers.list": return;
      case "threads.list": result = { threads: [thread()] }; break;
      case "projects.list": result = { projects: [{ id: "project" }] }; break;
      case "approvals.list": result = { approvals: [] }; break;
      case "queue.list": result = { messages: [] }; break;
      case "settings.get": result = { default_provider: "codex", providers: {} }; break;
      case "threads.get":
        downloads++;
        result = { thread: thread(), transcript: [{ role: "assistant", id: "m", turn_id: "turn", seq: 10, text: "Hello", complete: false }], pending_approvals: [] }; break;
      default: result = {};
    }
    queueMicrotask(() => this.reply(request, result));
  }
  subscribe(id, supported = true) {
    this.id = id;
    this.reply(this.sent.find(r => r.method === "events.subscribe"), { subscription_id: id, head_seq: head, replay_ready: supported });
  }
  ready() { this.frame({ jsonrpc: "2.0", method: "events.ready", params: { subscription_id: this.id, head_seq: head } }); }
  delta(seq, delta) { this.frame({ jsonrpc: "2.0", method: "event", params: { subscription_id: this.id, event: { thread_id: "thread", turn_id: "turn", at: "2026-09-10T00:00:00Z", seq, kind: "assistant_text_delta", message_id: "m", origin: { kind: "root" }, delta } } }); }
}
const tick = () => new Promise(setImmediate);
test("mobile keeps the workspace responsive and catches up cached threads without another snapshot", async (t) => {
  const previousSocket = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  t.after(() => { unsubscribers.forEach(fn => fn()); runtime.connect(null); globalThis.WebSocket = previousSocket; });
  await runtime.boot();
  runtime.useThread("thread");
  sockets[0].open(); await tick(); sockets[0].subscribe("initial"); await tick(); sockets[0].ready(); await tick();
  assert.equal(downloads, 1);
  assert.equal(runtime.getState().threads.length, 1, "slow provider discovery does not block workspace publication");
  const before = runtime.useThread("thread");
  await runtime.ensureThread("thread"); assert.equal(downloads, 1);
  sockets[0].interrupt();
  assert.equal(runtime.useThread("thread"), before);
  head = 12;
  await runtime.currentClient().checkConnection(); sockets[1].open(); await tick();
  sockets[1].subscribe("resumed"); await tick();
  assert.equal(downloads, 1);
  sockets[1].delta(11, " after"); sockets[1].delta(12, " reconnect");
  const replayed = runtime.useThread("thread");
  sockets[1].ready(); await tick();
  assert.equal(downloads, 1);
  assert.equal(runtime.useThread("thread"), replayed);
  assert.equal(replayed.blocks[0].text, "Hello after reconnect");
  sockets[1].interrupt();
  await runtime.currentClient().checkConnection(); sockets[2].open(); await tick();
  sockets[2].subscribe("legacy", false); await tick();
  assert.equal(downloads, 2, "legacy daemon uses the snapshot fallback");
});
