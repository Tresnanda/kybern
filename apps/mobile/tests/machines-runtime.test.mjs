import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { nativeModuleSource, seedSecure } from "./native-mocks.mjs";
import { PROTOCOL_VERSION } from "../../../packages/kybern-client/src/types.ts";
// Two machines saved in the phone's own format: the records, one token each, and the one the phone is at.
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
globalThis.reconnectSubscribe = (subscribe, getSnapshot) => {
  unsubscribers.push(subscribe(() => {}));
  return getSnapshot();
};
registerHooks({ resolve(specifier, context, next) {
  const source = nativeModuleSource(specifier);
  if (source) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` };
  const url = specifier.startsWith(".") && context.parentURL ? new URL(specifier, context.parentURL) : null;
  if (url?.protocol === "file:" && !/\.[a-z]+$/i.test(url.pathname) && existsSync(fileURLToPath(url) + ".ts")) return { shortCircuit: true, url: url.href + ".ts" };
  return next(specifier, context);
} });
const runtime = await import("../src/state/runtime.ts");
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
const methods = (socket) => socket.sent.map(r => r.method);
test("two saved machines: the phone's computer keeps its one socket, the set opens the other, and the computer is never asked twice", async (t) => {
  const previousSocket = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  t.after(() => { unsubscribers.forEach(fn => fn()); runtime.connect(null); runtime.resetMachineHub(); globalThis.WebSocket = previousSocket; });
  await runtime.boot();
  const host = sockets.find(s => s.machine === "host");
  host.open(); await tick(); host.subscribe("s"); await tick(); host.ready(); await tick();
  const other = sockets.find(s => s.machine === "other");
  assert.ok(other, "the set connects the other saved machine itself");
  assert.equal(sockets.filter(s => s.machine === "host").length, 1, "one socket to the computer the phone is at");
  assert.equal(host.url, "ws://localhost/ws");
  assert.equal(other.url, "wss://other.example/ws");
  assert.equal(other.headers.Authorization, "Bearer other-token", "its own token, over the native transport");
  assert.equal(host.headers.Authorization, "Bearer fixture");
  other.open(); await tick();
  const hub = runtime.machineHub();
  assert.deepEqual(hub.connections().map(c => [c.record.machineId, c.status === "offline" ? "offline" : "live"]), [["host", "live"], ["other", "live"]]);
  assert.equal(hub.localMachineId, "host");
  assert.equal(hub.primaryMachineId, "host");
  // The computer the phone is at is asked what a single-computer app asks, each once.
  assert.deepEqual([...new Set(methods(host))].sort(), ["approvals.list", "daemon.info", "events.subscribe", "notes.list", "projects.list", "providers.list", "queue.list", "requests.progress", "settings.get", "tasks.items.list", "threads.list"]);
  for (const method of ["threads.list", "projects.list", "daemon.info"]) assert.equal(host.sent.filter(r => r.method === method).length, 1, method);
  // The other machine's lists are read by the set (on connect, and once more by `ensureAll`'s refresh), never by the app.
  for (const method of ["projects.list", "threads.list"]) {
    const reads = other.sent.filter(r => r.method === method).length;
    assert.ok(reads >= 1 && reads <= 2, `${method} read ${reads} times`);
  }
  assert.equal(runtime.getState().threads.length, 1, "the computer's own state is only its own");
  // Merged lists: both machines' threads, the other one's flagged as living elsewhere.
  const unwatch = hub.subscribe(() => {});
  await new Promise(resolve => setTimeout(resolve, 350));
  const lists = runtime.listsOf(hub.view(), null);
  unwatch();
  assert.deepEqual(lists.threads.map(x => x.id), ["t-other", "thread"]);
  assert.equal(lists.machineOfThread("t-other").showGlyph, true);
  assert.equal(lists.machineOfThread("thread").showGlyph, false);
  assert.deepEqual(lists.projects.map(p => p.id), ["project"], "one repository on two machines is one project");
  assert.deepEqual(runtime.listsOf(hub.view(), "other").threads.map(x => x.id), ["t-other"]);
  // Requests: no machine id means the computer the phone is at; a thread or project picks its own machine.
  assert.deepEqual(await runtime.rpc("queue.list", {}), { messages: [] });
  const before = methods(host).length;
  await runtime.rpc("threads.get", { thread_id: "t-other" });
  await runtime.rpc("queue.list", {}, "other");
  assert.deepEqual(methods(other).slice(-2), ["threads.get", "queue.list"]);
  assert.equal(methods(host).length, before, "nothing about the other machine's thread reached this computer");
  // A write refreshes the machine it went to, not this computer.
  const hostLists = host.sent.filter(r => r.method === "threads.list").length;
  const otherLists = other.sent.filter(r => r.method === "threads.list").length;
  await runtime.mutate("threads.update", { thread_id: "t-other", pinned: true });
  assert.equal(other.sent.filter(r => r.method === "threads.update").length, 1);
  assert.equal(other.sent.filter(r => r.method === "threads.list").length, otherLists + 1);
  assert.equal(host.sent.filter(r => r.method === "threads.list").length, hostLists);
  // Offline machines say so instead of falling back to this computer.
  other.close(); other.onclose?.({ code: 1006 }); await tick();
  await assert.rejects(runtime.rpc("threads.get", { thread_id: "t-other" }), /offline/i);
  assert.equal(runtime.errorText(new (class extends Error { name = "OfflineError"; })("x")).startsWith("That machine is offline"), true);
});
