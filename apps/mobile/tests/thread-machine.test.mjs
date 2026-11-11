// #245: every thread uses its own machine. With the computer the phone is at away, a thread on another
// online machine loads, follows its events, answers approvals and reads as online; shared data (spaces)
// comes through a live member; the away computer's lists stay as cached copies.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { nativeModuleSource, seedSecure } from "./native-mocks.mjs";
import { PROTOCOL_VERSION } from "../../../packages/kybern-client/src/types.ts";
const records = [
  { machineId: "host", name: "Mac", routes: [{ kind: "direct_advertised", url: "http://localhost" }], member: false },
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
const spaces = await import("../src/state/spaces.ts");
const choice = await import("../src/state/machineChoice.ts");
const settingsStore = await import("../src/state/settings.ts");
const sockets = [];
const project = (id) => ({ id, name: id, path: `/${id}`, is_git: true, brief_in_all_threads: false, repo: { root_commit: `r-${id}` }, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" });
const entry = (id, project_id, updated_at) => ({ id, project_id, last_seq: 1, status: "running", pinned: false, title: id, provider: { kind: "codex" }, updated_at });
class Socket {
  readyState = 0; sent = []; url;
  constructor(url) { this.url = url; this.machine = url.includes("other") ? "other" : "host"; sockets.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; }
  drop() { this.close(); this.onclose?.({ code: 1006 }); }
  frame(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  reply(request, result) { this.frame({ jsonrpc: "2.0", id: request.id, result }); }
  send(text) {
    const request = JSON.parse(text); this.sent.push(request);
    const other = this.machine === "other";
    let result;
    switch (request.method) {
      case "daemon.info": result = { protocol_version: PROTOCOL_VERSION, environment_id: this.machine, machine_id: this.machine, features: other ? ["network.v1"] : [] }; break;
      case "events.subscribe": return void (other && queueMicrotask(() => this.reply(request, { subscription_id: "o", head_seq: 1, replay_ready: true })));
      case "providers.list": return;
      case "threads.list": result = other
        ? { threads: [entry("t-other", "o1", "2026-10-03T00:00:00Z")], activity: [{ thread_id: "t-other", active_agents: 0, active_processes: 0, active_monitors: 0, pending_request: "approval" }] }
        : { threads: [entry("thread", "project", "2026-10-01T00:00:00Z")] }; break;
      case "projects.list": result = { projects: [project(other ? "o1" : "project")] }; break;
      case "threads.get": result = { thread: entry(request.params.thread_id, "o1", "2026-10-03T00:00:00Z"), transcript: [{ role: "assistant", id: "m", turn_id: "turn", seq: 1, text: "From Satyamas", complete: true }], pending_approvals: [] }; break;
      case "spaces.list": result = { spaces: [{ id: "s1", name: "Work", color: "blue", position: 0, is_default: true }], placements: [] }; break;
      case "network.status": result = { enabled: true, members: [], found: [], outbox: {}, tailscale: {} }; break;
      case "approvals.list": result = { approvals: other ? [{ id: "a-other", thread_id: "t-other", kind: "command", title: "Run ls" }] : [] }; break;
      case "spaces.create": result = { id: "s2", name: request.params.name, color: request.params.color, position: 1, is_default: false }; break;
      case "providers.accounts.list": result = { accounts: [] }; break;
      case "queue.list": result = { messages: [] }; break;
      case "settings.get": result = { default_provider: "codex", providers: {} }; break;
      case "settings.update": result = request.params.settings; break;
      default: result = {};
    }
    queueMicrotask(() => this.reply(request, result));
  }
  subscribe(id) { this.reply(this.sent.find(r => r.method === "events.subscribe"), { subscription_id: id, head_seq: 1, replay_ready: true }); }
  ready() { this.frame({ jsonrpc: "2.0", method: "events.ready", params: { subscription_id: "s", head_seq: 1 } }); }
}
const tick = async () => { for (let i = 0; i < 10; i++) await new Promise(setImmediate); };
const methods = (socket) => socket.sent.map(r => r.method);

test("with the computer the phone is at away, a thread on another machine works through that machine", async (t) => {
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
  assert.equal(runtime.threadMachine("t-other"), "other");
  assert.equal(runtime.threadMachine("thread"), undefined, "the computer the phone is at");
  await tick();
  assert.deepEqual(runtime.getState().approvals.map(a => a.id), ["a-other"], "another machine's waiting approval is listed");

  // The computer goes away.
  host.drop(); await tick();
  assert.notEqual(runtime.getState().status, "open");
  const remote = runtime.threadConnection("t-other");
  assert.equal(remote.open, true, "the other machine's thread reads as online");
  assert.equal(remote.name, "Satyamas");
  assert.equal(remote.remote, true);
  const away = runtime.threadConnection("thread");
  assert.equal(away.open, false, "the away computer's thread shows the banner");
  assert.equal(away.name, "Mac", "the banner names the thread's own machine");

  // Opening the thread loads it from its own machine and follows its events there.
  runtime.useThread("t-other");
  await runtime.ensureThread("t-other"); await tick();
  assert.ok(methods(other).includes("threads.get"));
  assert.ok(methods(other).includes("events.subscribe"));
  assert.equal(runtime.useThread("t-other").loaded, true);
  assert.equal(host.sent.filter(r => r.method === "threads.get").length, 0);
  assert.deepEqual(other.sent.filter(r => r.method === "queue.list").at(-1)?.params, { thread_id: "t-other" }, "its queued prompts come from its machine");

  // Approvals, terminals and workspace calls go to the thread's machine.
  const hostBefore = host.sent.length;
  await runtime.respondApproval({ id: "a1", thread_id: "t-other" }, { decision: "allow_once" });
  assert.deepEqual(other.sent.filter(r => r.method === "approvals.respond").map(r => r.params), [{ approval_id: "a1", decision: "allow_once" }]);
  await runtime.rpc("terminals.input", { terminal_id: "term", data: "bHM=" }, runtime.threadMachine("t-other"));
  await runtime.rpc("git.status", { thread_id: "t-other" });
  assert.ok(methods(other).includes("terminals.input") && methods(other).includes("git.status"));
  assert.equal(host.sent.length, hostBefore, "nothing about the other machine's thread reached the away computer");

  // Shared data comes through the live member. (A member proves its identity on connect; the fake
  // cannot sign, so the record is marked a member here, as `network.status` from the computer would.)
  hub.set.connection("other").record.member = true;
  assert.equal(runtime.networkClient(), hub.clientFor("other"));
  spaces.loadSpacesThroughNetwork(); await tick();
  assert.ok(methods(other).includes("spaces.list"));
  assert.deepEqual(spaces.useSpaces().spaces.map(s => s.id), ["s1"]);
  assert.equal(spaces.useSpaces().from, "other", "logos load from the member that listed the spaces");
  await spaces.createSpace("Side", "green");
  assert.ok(methods(other).includes("spaces.create"), "a space change goes through the live member");
  assert.equal(host.sent.filter(r => r.method === "spaces.create").length, 0);
  assert.deepEqual(runtime.getState().approvals.map(a => a.id), ["a-other"], "its approvals stay listed while the computer is away");
  await runtime.rpc("providers.accounts.list", { kind: "codex" }, runtime.threadMachine("t-other"));
  assert.ok(methods(other).includes("providers.accounts.list"));

  // Settings show a live machine while the computer is away, and read and write there.
  assert.equal(choice.settingsChoice()?.machineId, "other");
  const settingsBefore = other.sent.filter(r => r.method === "settings.get").length;
  await settingsStore.loadSettings();
  assert.equal(other.sent.filter(r => r.method === "settings.get").length, settingsBefore + 1);
  assert.equal(settingsStore.useSettings().settings?.default_provider, "codex");
  await settingsStore.saveSettings({ ...settingsStore.useSettings().settings, generate_titles: true });
  assert.ok(methods(other).includes("settings.update"));
  assert.equal(host.sent.filter(r => r.method === "settings.update").length, 0);

  // The away computer's lists stay as cached copies, greyed.
  const lists = runtime.listsOf(hub.view(), null);
  assert.deepEqual(lists.threads.map(x => x.id).sort(), ["t-other", "thread"]);
  assert.equal(lists.machineOfThread("thread").offline, true);
  assert.equal(lists.machineOfThread("t-other").offline, false);
  assert.ok(lists.projects.some(p => p.id === "project"), "its projects still count in their space");
  unwatch();
});
