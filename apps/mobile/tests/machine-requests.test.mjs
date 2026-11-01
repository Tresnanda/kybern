import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { nativeModuleSource, seedSecure } from "./native-mocks.mjs";
import { PROTOCOL_VERSION } from "../../../packages/kybern-client/src/types.ts";
const records = [
  { machineId: "host", name: "Test host", routes: [{ kind: "direct_advertised", url: "http://localhost" }], member: false },
  { machineId: "other", name: "Satyamas", routes: [{ kind: "direct_advertised", url: "https://other.example" }], member: false },
];
seedSecure({
  "kybern.ink.machines": JSON.stringify({ version: 1, records }),
  "kybern.ink.active": "host",
  "kybern.ink.token.host": "fixture",
  "kybern.ink.token.other": "other-token",
});
const unsubscribers = [];
globalThis.reconnectSubscribe = (subscribe, getSnapshot) => { unsubscribers.push(subscribe(() => {})); return getSnapshot(); };
registerHooks({ resolve(specifier, context, next) {
  const source = nativeModuleSource(specifier);
  if (source) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` };
  const url = specifier.startsWith(".") && context.parentURL ? new URL(specifier, context.parentURL) : null;
  if (url?.protocol === "file:" && !/\.[a-z]+$/i.test(url.pathname) && existsSync(fileURLToPath(url) + ".ts")) return { shortCircuit: true, url: url.href + ".ts" };
  return next(specifier, context);
} });
const runtime = await import("../src/state/runtime.ts");
const requests = await import("../src/state/machineRequests.ts");
const sockets = [];
const project = (id) => ({ id, name: id, path: `/${id}`, is_git: true, brief_in_all_threads: false, repo: { root_commit: "r-1" }, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" });
const entry = (id, project_id, updated_at) => ({ id, project_id, last_seq: 1, status: "idle", pinned: false, title: id, provider: { kind: "codex" }, updated_at });
class Socket {
  readyState = 0; sent = []; url; headers;
  constructor(url, protocols, options) { this.url = url; this.headers = options?.headers; this.machine = url.includes("other") ? "other" : "host"; sockets.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; }
  frame(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  reply(request, result) { this.frame({ jsonrpc: "2.0", id: request.id, result }); }
  send(text) {
    const request = JSON.parse(text); this.sent.push(request);
    const other = this.machine === "other";
    let result;
    switch (request.method) {
      case "daemon.info": result = { protocol_version: PROTOCOL_VERSION, environment_id: this.machine, features: [] }; break;
      case "events.subscribe": case "providers.list": return;
      case "threads.list": result = { threads: other ? [entry("t-other", "o1", "2026-10-03T00:00:00Z")] : [entry("thread", "project", "2026-10-01T00:00:00Z")] }; break;
      case "projects.list": result = { projects: [project(other ? "o1" : "project")] }; break;
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

test("requests go to the machine that owns the thing, with that machine's own token", async (t) => {
  const previousSocket = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  t.after(() => { unsubscribers.forEach(fn => fn()); runtime.connect(null); runtime.resetMachineHub(); globalThis.WebSocket = previousSocket; });
  await runtime.boot();
  const host = sockets.find(s => s.machine === "host");
  host.open(); await tick(); host.subscribe("s"); await tick(); host.ready(); await tick();
  const other = sockets.find(s => s.machine === "other");
  other.open(); await tick();
  const hub = runtime.machineHub();
  const unwatch = hub.subscribe(() => {});
  await new Promise(resolve => setTimeout(resolve, 350));
  unwatch();

  // No owner: the computer the phone is at.
  assert.deepEqual(requests.assetSource("a 1"), { uri: "http://localhost/assets/a%201", headers: { authorization: "Bearer fixture" } });
  // A machine, or a thread listed on it.
  assert.deepEqual(requests.assetSource("a1", { machineId: "other" }), { uri: "https://other.example/assets/a1", headers: { authorization: "Bearer other-token" } });
  assert.equal(requests.threadImageSource("t-other", "/w/a b.png")?.uri, "https://other.example/threads/t-other/image?path=%2Fw%2Fa%20b.png");
  assert.equal(requests.threadImageSource("thread", "x.png")?.headers.authorization, "Bearer fixture");
  assert.equal(requests.machineClient("other")?.request("/x").url, "https://other.example/x");
  assert.equal(requests.machineClient("host"), runtime.currentClient());

  // Uploads: to the owner, with its headers.
  globalThis.__fetches = [];
  const asset = await requests.uploadAsset({ uri: "file:///a.png" }, { name: "a b.png", mimeType: "image/png" }, { threadId: "t-other" });
  assert.equal(asset.id, "a1");
  assert.equal(globalThis.__fetches[0].url, "https://other.example/assets");
  assert.equal(globalThis.__fetches[0].init.headers.authorization, "Bearer other-token");
  assert.equal(globalThis.__fetches[0].init.headers["x-kybern-filename"], "a%20b.png");

  // Offline: no source, no client; an upload queues on the member the phone is at.
  other.close(); other.onclose?.({ code: 1006 }); await tick();
  assert.equal(requests.machineSource("/assets/a1", { machineId: "other" }), undefined);
  assert.equal(requests.machineClient("other"), null);
  globalThis.__fetches = [];
  await requests.uploadAsset({ uri: "file:///a.png" }, { name: "a.png" }, { machineId: "other" });
  assert.equal(globalThis.__fetches[0].url, "http://localhost/assets");
});
