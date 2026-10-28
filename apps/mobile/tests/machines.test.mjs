import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
// Extensionless imports in the app's sources resolve to `.ts`, as in the other state tests.
registerHooks({ resolve(specifier, context, next) {
  const url = specifier.startsWith(".") && context.parentURL ? new URL(specifier, context.parentURL) : null;
  if (url?.protocol === "file:" && !/\.[a-z]+$/i.test(url.pathname) && existsSync(fileURLToPath(url) + ".ts")) return { shortCircuit: true, url: url.href + ".ts" };
  return next(specifier, context);
} });
const { MachineHub } = await import("../src/machines/hub.ts");
const { LEGACY_PREFIX, recordOfComputer, recordsFromComputers, routeUrl } = await import("../src/machines/records.ts");
const { MERGED_LISTS_ENABLED } = await import("../src/machines/flag.ts");
const { OfflineError } = await import("../../../packages/kybern-client/src/machines.ts");

const project = (id, name, root) => ({ id, name, path: `/w/${name}`, is_git: true, brief_in_all_threads: false, repo: { root_commit: root }, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" });
const thread = (id, project_id, updated_at) => ({ id, project_id, title: id, status: "idle", pinned: false, updated_at });

/** A daemon connection: `KybernClient`'s surface, answering from `handlers`. */
class FakeDaemon {
  status = "idle"; calls = []; closed = 0; online = true;
  endpoint = { url: "ws://fake/ws", token: "tok" };
  statuses = new Set(); notifications = new Map();
  constructor(machineId, handlers = {}) {
    this.machineId = machineId; this.handlers = handlers;
    this.info = { environment_id: machineId, machine_id: machineId, version: "0.19.0", features: [] };
  }
  setStatus(status) { this.status = status; for (const fn of [...this.statuses]) fn(status); }
  connect() { queueMicrotask(() => { if (this.online) this.setStatus("open"); }); }
  close() { this.closed++; this.status = "closed"; }
  onStatus(fn) { this.statuses.add(fn); return () => this.statuses.delete(fn); }
  onNotification(method, fn) {
    const set = this.notifications.get(method) ?? new Set();
    set.add(fn); this.notifications.set(method, set);
    return () => set.delete(fn);
  }
  notify(method) { for (const fn of this.notifications.get(method) ?? []) fn({}); }
  async checkConnection() {}
  async call(method, params) {
    this.calls.push(method);
    const handler = this.handlers[method];
    if (!handler) throw new Error(`no handler for ${method}`);
    return handler(params);
  }
  callRaw(method, params) { return this.call(method, params); }
  subscribeEvents() { return { unsubscribe() {}, lastSeq: undefined }; }
}

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };
const computer = (id, extra = {}) => ({ id, name: id, url: `wss://${id}.example/ws`, token: `tok-${id}`, ...extra });

const hubs = [];
function makeHub(computers, { merged = false, transport } = {}) {
  const timers = [];
  const state = { computers };
  const hub = new MachineHub({
    records: () => recordsFromComputers(state.computers),
    readCredential: (id) => state.computers.find((c) => c.id === id)?.token,
    mergedLists: () => merged,
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
    ...(transport ? { transport } : {}),
  });
  hubs.push(hub);
  return { hub, state, runTimers: () => timers.splice(0).forEach((fn) => fn()) };
}
async function openPrimary(hub, daemon, profile, lists) {
  hub.beginPrimary(daemon, profile);
  daemon.setStatus("open");
  const adopted = hub.primaryOpened(daemon);
  if (lists) hub.ingestPrimary(daemon, lists.projects, lists.threads);
  await adopted;
  await settle();
}
test.afterEach(() => { for (const hub of hubs.splice(0)) hub.dispose(); });

test("merged lists stay off until N4 lands", () => {
  assert.equal(MERGED_LISTS_ENABLED, false);
});

test("saved computers become machine records, not members, with their id in legacyProfileId", () => {
  const records = recordsFromComputers([computer("env-1", { environmentId: "env-1" }), computer("old", { url: "ws://10.0.0.2:4173/ws" })]);
  assert.deepEqual(records.map((r) => [r.legacyProfileId, r.machineId, r.member]), [["env-1", "env-1", false], ["old", `${LEGACY_PREFIX}old`, false]]);
  assert.deepEqual(records[1].routes, [{ kind: "direct_advertised", url: "http://10.0.0.2:4173" }]);
  assert.equal(routeUrl("wss://mac.tail.ts.net/ws"), "https://mac.tail.ts.net");
  assert.deepEqual(recordOfComputer({ id: "x", name: "X", url: "", token: "t" }).routes, []);
});

test("one computer: the daemon joins the set under its own id, replacing the stand-in, with no daemon calls", async () => {
  const { hub } = makeHub([computer("mac")]);
  const daemon = new FakeDaemon("mac-1", { "projects.list": () => { throw new Error("the set must not read lists the app already has"); } });
  await openPrimary(hub, daemon, { id: "mac", name: "Mac" }, { projects: [project("p1", "kybern", "r1")], threads: [thread("t1", "p1", "2026-10-02T00:00:00Z")] });
  assert.deepEqual(hub.connections().map((c) => [c.record.machineId, c.record.legacyProfileId, c.status]), [["mac-1", "mac", "needs-update"]]);
  assert.equal(hub.localMachineId, "mac-1");
  assert.equal(hub.primaryMachineId, "mac-1");
  assert.deepEqual(daemon.calls, []);
  assert.equal(daemon.closed, 0);
  assert.equal(hub.machineOfThread("new-chat"), "mac-1");
  assert.equal(hub.clientForThread("new-chat"), hub.clientFor("mac-1"));
});

test("merged lists off: a later refresh never reaches the set, even with a reader", async () => {
  const { hub, runTimers } = makeHub([computer("mac")]);
  const daemon = new FakeDaemon("mac-1");
  const p1 = project("p1", "kybern", "r1");
  await openPrimary(hub, daemon, { id: "mac", name: "Mac" }, { projects: [p1], threads: [thread("t1", "p1", "2026-10-02T00:00:00Z")] });
  // Joining read the app's first lists once, by reference.
  const first = hub.view();
  assert.deepEqual(first.threads.all.map((t) => [t.machineId, t.thread.id]), [["mac-1", "t1"]]);
  assert.equal(first.showGlyphs, false);
  hub.subscribe(() => {});
  hub.ingestPrimary(daemon, [p1], [thread("t1", "p1", "2026-10-02T00:00:00Z"), thread("t2", "p1", "2026-10-03T00:00:00Z")]);
  runTimers();
  assert.equal(hub.view(), first);
  assert.deepEqual(daemon.calls, []);
});

test("merged lists on, one machine: no glyphs, and refreshes wait by reference until a reader exists", async () => {
  const { hub, runTimers } = makeHub([computer("mac")], { merged: true });
  const daemon = new FakeDaemon("mac-1");
  const p1 = project("p1", "kybern", "r1");
  await openPrimary(hub, daemon, { id: "mac", name: "Mac" }, { projects: [p1], threads: [thread("t1", "p1", "2026-10-02T00:00:00Z")] });
  const first = hub.view();
  const next = [thread("t1", "p1", "2026-10-02T00:00:00Z"), thread("t2", "p1", "2026-10-03T00:00:00Z")];
  hub.ingestPrimary(daemon, [p1], next);
  runTimers();
  assert.equal(hub.view(), first);
  const seen = [];
  const off = hub.subscribe(() => seen.push(1));
  runTimers();
  const view = hub.view();
  assert.deepEqual(view.threads.all.map((t) => [t.machineId, t.thread.id]), [["mac-1", "t2"], ["mac-1", "t1"]]);
  assert.equal(view.showGlyphs, false);
  assert.equal(hub.view(), view);
  assert.ok(seen.length > 0);
  off();
});

test("the primary leaving never closes the app's own client and resuming reuses the machine", async () => {
  const { hub } = makeHub([computer("mac")]);
  const daemon = new FakeDaemon("mac-1");
  await openPrimary(hub, daemon, { id: "mac", name: "Mac" });
  hub.releasePrimary();
  daemon.close();
  await settle();
  assert.equal(hub.set.connection("mac-1")?.status, "paused");
  assert.throws(() => hub.clientFor("mac-1"), OfflineError);
  const again = new FakeDaemon("mac-1");
  await openPrimary(hub, again, { id: "mac", name: "Mac" });
  assert.equal(hub.set.connection("mac-1")?.status, "needs-update");
  assert.equal(hub.connections().length, 1);
  assert.equal(daemon.closed, 1);
  assert.equal(again.closed, 0);
});

test("a saved computer is listed but never connected while the app uses one", async () => {
  const created = [];
  const { hub } = makeHub([computer("vps", { environmentId: "vps-1" })], { transport: { createClient: ({ record }) => { created.push(record.machineId); return new FakeDaemon(record.machineId); } } });
  await openPrimary(hub, new FakeDaemon("mac-1"), { id: "mac", name: "Mac" });
  assert.deepEqual(hub.connections().map((c) => [c.record.machineId, c.status]).sort(), [["mac-1", "needs-update"], ["vps-1", "offline"]]);
  assert.deepEqual(created, []);
});

test("merged lists on, several machines: lists merge and clients are routed by thread and project", async () => {
  const vps = new FakeDaemon("vps-1", {
    "projects.list": () => ({ projects: [project("p9", "kybern", "r1"), project("p10", "site", "r2")] }),
    "threads.list": () => ({ threads: [thread("t-v", "p9", "2026-10-03T00:00:00Z"), thread("t-same", "p9", "2026-10-01T00:00:00Z")] }),
  });
  const { hub, runTimers } = makeHub([computer("mac"), computer("vps", { environmentId: "vps-1" })], { merged: true, transport: { createClient: () => vps } });
  const mac = new FakeDaemon("mac-1");
  await openPrimary(hub, mac, { id: "mac", name: "Mac" }, { projects: [project("p1", "kybern", "r1")], threads: [thread("t-m", "p1", "2026-10-02T00:00:00Z"), thread("t-same", "p1", "2026-10-04T00:00:00Z")] });
  await hub.set.ensureAll();
  runTimers();
  await settle();
  const view = hub.view();
  assert.equal(view.showGlyphs, true);
  assert.deepEqual(view.machines.map((m) => [m.machineId, m.showGlyph, m.isLocal]), [["mac-1", false, true], ["vps-1", true, false]]);
  assert.deepEqual(view.projects.map((p) => [p.name, p.instances.map((i) => i.machineId)]), [["kybern", ["mac-1", "vps-1"]], ["site", ["vps-1"]]]);
  assert.deepEqual(view.threads.all.map((t) => [t.machineId, t.thread.id]), [["mac-1", "t-same"], ["vps-1", "t-v"], ["mac-1", "t-m"], ["vps-1", "t-same"]]);
  assert.equal(hub.machineOfThread("t-v"), "vps-1");
  assert.equal(hub.machineOfThread("t-same"), "mac-1");
  assert.equal(hub.machineOfThread("t-same", "vps-1"), "vps-1");
  assert.equal(hub.clientForProject("p10"), hub.clientFor("vps-1"));
  assert.equal(hub.clientForProject("p1"), hub.clientFor("mac-1"));
  assert.deepEqual(mac.calls, []);
});

test("merged lists on: opening the primary connects the other saved computers by itself", async () => {
  const vps = new FakeDaemon("vps-1", { "projects.list": () => ({ projects: [] }), "threads.list": () => ({ threads: [] }) });
  const { hub } = makeHub([computer("mac"), computer("vps", { environmentId: "vps-1" })], { merged: true, transport: { createClient: () => vps } });
  await openPrimary(hub, new FakeDaemon("mac-1"), { id: "mac", name: "Mac" }, { projects: [], threads: [] });
  assert.equal(hub.set.connection("vps-1")?.status, "needs-update");
});

test("merged lists on: saved computers added or removed later join and leave the set, never the primary", async () => {
  const dials = [];
  const { hub, state } = makeHub([computer("mac")], { merged: true, transport: { createClient: ({ record }) => { dials.push(record.machineId); return new FakeDaemon(record.machineId, { "projects.list": () => ({ projects: [] }), "threads.list": () => ({ threads: [] }) }); } } });
  await openPrimary(hub, new FakeDaemon("mac-1"), { id: "mac", name: "Mac" }, { projects: [], threads: [] });
  state.computers = [...state.computers, computer("vps", { environmentId: "vps-1" })];
  await hub.syncRecords();
  await settle();
  assert.deepEqual(hub.connections().map((c) => c.record.machineId), ["mac-1", "vps-1"]);
  assert.deepEqual(dials, ["vps-1"]);
  state.computers = state.computers.filter((c) => c.id !== "vps");
  await hub.syncRecords();
  assert.deepEqual(hub.connections().map((c) => c.record.machineId), ["mac-1"]);
});

test("merged lists off: adding a saved computer changes nothing until the next start", async () => {
  const { hub, state } = makeHub([computer("mac")]);
  await openPrimary(hub, new FakeDaemon("mac-1"), { id: "mac", name: "Mac" });
  state.computers = [...state.computers, computer("vps", { environmentId: "vps-1" })];
  await hub.syncRecords();
  assert.deepEqual(hub.connections().map((c) => c.record.machineId), ["mac-1"]);
});

test("the primary is never dialed by the set, and a stand-in record does not survive its daemon's real id", async () => {
  const created = [];
  const { hub } = makeHub([computer("mac"), computer("vps", { environmentId: "vps-1" })], { transport: { createClient: ({ record }) => { created.push(record.machineId); return new FakeDaemon(record.machineId); } } });
  await openPrimary(hub, new FakeDaemon("mac-1"), { id: "mac", name: "Mac" });
  hub.releasePrimary();
  await settle();
  await hub.set.networkChanged();
  await settle();
  assert.deepEqual(created.filter((id) => id === "mac-1"), []);
  assert.deepEqual(hub.connections().filter((c) => c.record.legacyProfileId === "mac").map((c) => c.record.machineId), ["mac-1"]);
});

test("a machine's token comes from its saved computer, never the primary's placeholder", async () => {
  const tokens = [];
  const { hub } = makeHub([computer("mac"), computer("vps", { environmentId: "vps-1" })], { merged: true, transport: { createClient: ({ record, token }) => { tokens.push([record.machineId, token]); return new FakeDaemon(record.machineId, { "projects.list": () => ({ projects: [] }), "threads.list": () => ({ threads: [] }) }); } } });
  await openPrimary(hub, new FakeDaemon("mac-1"), { id: "mac", name: "Mac" }, { projects: [], threads: [] });
  assert.deepEqual(tokens, [["vps-1", "tok-vps"]]);
});
