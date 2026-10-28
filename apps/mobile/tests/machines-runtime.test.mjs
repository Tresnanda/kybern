import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PROTOCOL_VERSION } from "../../../packages/kybern-client/src/types.ts";
const saved = JSON.stringify({ environments: [
  { id: "host", name: "Test host", url: "ws://localhost/ws", token: "fixture", environmentId: "host" },
  { id: "other", name: "Other", url: "wss://other.example/ws", token: "other-token", environmentId: "other" },
], activeId: "host" });
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
class Socket {
  readyState = 0; sent = []; url;
  constructor(url) { this.url = url; sockets.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; }
  frame(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  reply(request, result) { this.frame({ jsonrpc: "2.0", id: request.id, result }); }
  send(text) {
    const request = JSON.parse(text); this.sent.push(request);
    let result;
    switch (request.method) {
      case "daemon.info": result = { protocol_version: PROTOCOL_VERSION, environment_id: "host" }; break;
      case "events.subscribe": case "providers.list": return;
      case "threads.list": result = { threads: [{ id: "thread", project_id: "project", last_seq: 1, status: "idle", updated_at: "2026-10-01T00:00:00Z" }] }; break;
      case "projects.list": result = { projects: [{ id: "project", name: "p", path: "/p" }] }; break;
      case "approvals.list": result = { approvals: [] }; break;
      case "queue.list": result = { messages: [] }; break;
      case "settings.get": result = { default_provider: "codex", providers: {} }; break;
      default: result = {};
    }
    queueMicrotask(() => this.reply(request, result));
  }
  subscribe(id) { this.reply(this.sent.find(r => r.method === "events.subscribe"), { subscription_id: id, head_seq: 1, replay_ready: true }); }
  ready() { this.frame({ jsonrpc: "2.0", method: "events.ready", params: { subscription_id: "s", head_seq: 1 } }); }
}
const tick = async () => { for (let i = 0; i < 10; i++) await new Promise(setImmediate); };
test("two saved computers: one socket, the other is a record, and the daemon is asked nothing extra", async (t) => {
  const previousSocket = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  t.after(() => { unsubscribers.forEach(fn => fn()); runtime.connect(null); runtime.resetMachineHub(); globalThis.WebSocket = previousSocket; });
  await runtime.boot();
  sockets[0].open(); await tick(); sockets[0].subscribe("s"); await tick(); sockets[0].ready(); await tick();
  assert.equal(sockets.length, 1, "only the active computer opens a socket");
  assert.equal(sockets[0].url, "ws://localhost/ws");
  const hub = runtime.machineHub();
  assert.deepEqual(hub.connections().map(c => [c.record.machineId, c.status === "offline" ? "offline" : "live"]).sort(), [["host", "live"], ["other", "offline"]]);
  assert.equal(hub.localMachineId, "host");
  // The set added no request: the methods a single-computer app sends at boot, each once.
  assert.deepEqual([...new Set(sockets[0].sent.map(r => r.method))].sort(), ["approvals.list", "daemon.info", "events.subscribe", "notes.list", "projects.list", "providers.list", "queue.list", "requests.progress", "settings.get", "tasks.items.list", "threads.list"]);
  for (const method of ["threads.list", "projects.list", "daemon.info"]) assert.equal(sockets[0].sent.filter(r => r.method === method).length, 1, method);
  assert.equal(runtime.getState().threads.length, 1);
  // An rpc without a machine id goes to the active computer; a machine id that is not the active one is routed by the hub.
  assert.deepEqual(await runtime.rpc("queue.list", {}), { messages: [] });
  await assert.rejects(runtime.rpc("queue.list", {}, "other"));
});
