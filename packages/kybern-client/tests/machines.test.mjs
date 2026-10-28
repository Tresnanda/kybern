import test from "node:test";
import assert from "node:assert/strict";
import { MachineSet, OfflineError, UnknownMachineError } from "../src/machines.ts";
import { MachineCache } from "../src/machineCache.ts";
import { routeId } from "../src/machineRoutes.ts";
import { fakeWorld, manualClock, memoryCacheStorage, memoryCredentials, memoryStore, verifyProof } from "./machine-fakes.mjs";

const T = "http://100.64.0.2:4173"; // b on the tailnet
const A = "https://b.example.com"; // b advertised
const tailnet = (url) => ({ kind: "direct_tailnet", url });
const advertised = (url) => ({ kind: "direct_advertised", url });
const rec = (machineId, routes, extra = {}) => ({ machineId, name: machineId, routes, member: true, ...extra });
const card = (machine_id, extra = {}) => ({ machine_id, name: machine_id, os: "linux", status: "online", ...extra });
const project = (id, name, root) => ({ id, name, path: `/w/${name}`, is_git: true, brief_in_all_threads: false, repo: { root_commit: root }, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" });
const thread = (id, project_id, updated_at, extra = {}) => ({ id, project_id, title: id, updated_at, ...extra });

function setup({ records = [], credentials = {}, cacheText, ...options } = {}) {
  const clock = manualClock();
  const world = fakeWorld(clock);
  const store = memoryStore(records);
  const creds = memoryCredentials(credentials);
  const storage = memoryCacheStorage(cacheText);
  const cache = new MachineCache(storage);
  const set = new MachineSet({
    store,
    credentials: creds,
    deviceId: "phone-1",
    verifyProof,
    transport: world.transport,
    clock,
    cache,
    ...options,
  });
  return { clock, world, store, creds, storage, cache, set };
}

const urlsOf = (world, machineId) => world.clients.filter((c) => c.machineId === machineId).map((c) => c.url);
const probesTo = (world, prefix) => world.probes.filter((u) => u.startsWith(prefix));

test("routes are tried in order: the first that verifies is kept", async () => {
  const { world, set, store } = setup({
    records: [rec("b", [advertised(A), tailnet(T)], { signingKey: "key-b" })],
    credentials: { b: "tok-b" },
  });
  world.host(T, "b", { online: false });
  world.host(A, "b");
  world.lists("b", [], []);
  await set.ensureAll();
  // Ordered by kind, whatever order the record listed them in: tailnet first, then advertised.
  assert.deepEqual(world.probes.map((u) => new URL(u).origin), [T, A]);
  assert.deepEqual(urlsOf(world, "b"), [A]);
  assert.equal(world.clients[0].token, "tok-b");
  const connection = set.connection("b");
  assert.equal(connection.status, "online");
  assert.equal(connection.route.kind, "direct_advertised");
  assert.ok(set.clientFor("b"));
  assert.equal(store.records[0].signingKey, "key-b");
  set.dispose();
});

test("a key mismatch is fatal for the route: no credential is sent, and the route is never tried again", async () => {
  const { world, set, store, clock } = setup({
    records: [rec("b", [tailnet(T), advertised(A)], { signingKey: "key-b" })],
    credentials: { b: "tok-b" },
  });
  // Something else answers at the tailnet address, claiming to be machine x.
  world.host(T, "b", { answerAs: { machineId: "x", key: "key-x" } });
  world.host(A, "b");
  world.lists("b", [], []);
  await set.ensureAll();
  assert.deepEqual(urlsOf(world, "b"), [A], "the token only ever went to the machine that proved who it was");
  assert.ok(world.clients.every((c) => c.url !== T));
  assert.deepEqual(store.records[0].blockedRoutes, [routeId(tailnet(T))]);
  assert.equal(set.connection("b").status, "online");

  // Nothing retries it silently, not a reconnect and not the periodic probe for better routes.
  const before = probesTo(world, T).length;
  await set.setPaused("b", true);
  await set.setPaused("b", false);
  await set.networkChanged();
  await clock.advance(10 * 60_000);
  assert.equal(probesTo(world, T).length, before);
  assert.ok(world.clients.every((c) => c.url !== T));

  // Until the user says so.
  world.host(T, "b");
  await set.clearBlockedRoutes("b", tailnet(T));
  assert.equal(set.connection("b").route.url, T);
  set.dispose();
});

test("when every address answers as someone else the machine is offline and no token leaves", async () => {
  const { world, set } = setup({
    records: [rec("b", [tailnet(T), advertised(A)], { signingKey: "key-b" })],
    credentials: { b: "tok-b" },
  });
  world.host(T, "b", { answerAs: { machineId: "c", key: "key-c" } });
  world.host(A, "b", { answerAs: { machineId: "b", key: "key-evil" } }); // right id, wrong key
  await set.ensureAll();
  assert.equal(world.clients.length, 0);
  const connection = set.connection("b");
  assert.equal(connection.status, "offline");
  assert.equal(connection.error.code, "identity_mismatch");
  assert.equal(connection.error.message, "This address answered as a different machine");
  assert.throws(() => set.clientFor("b"), OfflineError);
  set.dispose();
});

test("the first key a machine proves is pinned; later another key is refused", async () => {
  const { world, set, store } = setup({ records: [rec("b", [tailnet(T)])], credentials: { b: "tok-b" } });
  const host = world.host(T, "b");
  world.lists("b", [], []);
  await set.ensureAll();
  assert.equal(store.records[0].signingKey, "key-b");
  await set.setPaused("b", true);
  host.answerAs = { machineId: "b", key: "key-evil" };
  await set.setPaused("b", false);
  assert.equal(set.connection("b").status, "offline");
  assert.equal(world.clients.length, 1, "no second client: the changed key was refused before any token");
  set.dispose();
});

test("pinPolicy require never connects to a machine whose key was not given", async () => {
  const { world, set } = setup({ records: [rec("b", [tailnet(T)])], credentials: { b: "tok-b" }, pinPolicy: "require" });
  world.host(T, "b");
  await set.ensureAll();
  assert.equal(world.probes.length, 0);
  assert.equal(world.clients.length, 0);
  assert.equal(set.connection("b").error.code, "unpinned");
  set.dispose();
});

test("a stale proof is not an identity failure: nothing is blocked and the next route is tried", async () => {
  const { world, set, store, clock } = setup({
    records: [rec("b", [tailnet(T), advertised(A)], { signingKey: "key-b" })],
    credentials: { b: "tok-b" },
  });
  world.host(T, "b", { staleBy: 120_000 });
  world.host(A, "b");
  world.lists("b", [], []);
  await set.ensureAll();
  assert.equal(set.connection("b").route.url, A);
  assert.equal(store.records[0].blockedRoutes, undefined);
  set.dispose();
});

test("public plain-HTTP addresses are never used", async () => {
  const { world, set } = setup({ records: [rec("b", [advertised("http://example.com:4173")])], credentials: { b: "tok-b" } });
  world.host("http://example.com:4173", "b");
  await set.ensureAll();
  assert.equal(world.probes.length, 0);
  assert.equal(world.clients.length, 0);
  assert.equal(set.connection("b").error.code, "insecure_route");
  set.dispose();
});

test("a machine only reachable through a member is relayed, and shown as relaying", async () => {
  const { world, set } = setup({
    records: [rec("a", [tailnet("http://100.64.0.1:4173")], { signingKey: "key-a" }), rec("b", [tailnet(T)], { signingKey: "key-b" })],
    credentials: { a: "tok-a", b: "tok-b" },
    localMachineId: "a",
  });
  world.host("http://100.64.0.1:4173", "a");
  world.host("http://100.64.0.1:4173/relay/b", "b");
  world.lists("a", [], []);
  world.lists("b", [project("p", "x", "r1")], [thread("t", "p", "2026-10-28T10:00:00Z")]);
  await set.ensureAll();
  assert.equal(set.connection("a").status, "online");
  const b = set.connection("b");
  assert.equal(b.status, "relaying");
  assert.equal(b.relayVia, "a");
  assert.equal(b.route.kind, "relay");
  assert.ok(world.probes.some((u) => u.startsWith("http://100.64.0.1:4173/relay/b/http/.well-known/kybern/machine?nonce=")));
  assert.deepEqual(urlsOf(world, "b"), ["http://100.64.0.1:4173/relay/b"]);
  assert.equal(world.clients.find((c) => c.machineId === "b").token, "tok-b", "the relay carries b's own token; the member never sees it as its own");
  assert.equal(set.merged().threads.all.length, 1);
  set.dispose();
});

test("a relay is only offered through members that are connected", async () => {
  const { world, set } = setup({
    records: [rec("a", [tailnet("http://100.64.0.1:4173")], { signingKey: "key-a" }), rec("b", [], { signingKey: "key-b" })],
    credentials: { a: "tok-a", b: "tok-b" },
  });
  world.host("http://100.64.0.1:4173", "a", { online: false });
  world.host("http://100.64.0.1:4173/relay/b", "b");
  await set.ensureAll();
  assert.equal(set.connection("b").status, "offline");
  assert.equal(set.connection("b").error.code, "no_route");
  set.dispose();
});

test("a machine with no token gets one minted through a member, along with its routes", async () => {
  const { world, set, creds, store } = setup({
    records: [rec("a", [tailnet("http://100.64.0.1:4173")], { signingKey: "key-a" }), rec("b", [], { signingKey: "key-b" })],
    credentials: { a: "tok-a" },
    localMachineId: "a",
  });
  world.host("http://100.64.0.1:4173", "a");
  world.host(T, "b");
  world.lists("a", [], []);
  world.lists("b", [], []);
  const grants = [];
  world.on("a", "network.client_grant", (params) => {
    grants.push(params);
    return { token: "minted-b", scopes: [], routes: [tailnet(T)] };
  });
  await set.ensureAll();
  assert.deepEqual(grants, [{ machine_id: "b", device_id: "phone-1" }]);
  assert.equal(creds.tokens.get("b"), "minted-b");
  assert.equal(world.clients.find((c) => c.machineId === "b").token, "minted-b");
  assert.equal(set.connection("b").status, "online");
  assert.deepEqual(store.records.find((r) => r.machineId === "b").learned, [tailnet(T)]);
  set.dispose();
});

test("a machine nobody can mint a token for is unpaired and gets no connection", async () => {
  const { world, set } = setup({ records: [rec("b", [tailnet(T)], { signingKey: "key-b" })] });
  world.host(T, "b");
  await set.ensureAll();
  assert.equal(set.connection("b").status, "unpaired");
  assert.equal(set.connection("b").error.code, "unpaired");
  assert.equal(world.clients.length, 0);
  assert.equal(world.probes.length, 0, "nothing is probed without a credential to use");
  set.dispose();
});

test("a token the machine revoked is replaced by a fresh one through a member", async () => {
  const { world, set, creds } = setup({
    records: [rec("a", [tailnet("http://100.64.0.1:4173")], { signingKey: "key-a" }), rec("b", [tailnet(T)], { signingKey: "key-b" })],
    credentials: { a: "tok-a", b: "old" },
  });
  world.host("http://100.64.0.1:4173", "a");
  world.host(T, "b", { rejectToken: (token) => token === "old" });
  world.lists("a", [], []);
  world.lists("b", [], []);
  world.on("a", "network.client_grant", () => ({ token: "new", scopes: [], routes: [] }));
  await set.ensureAll();
  assert.equal(creds.tokens.get("b"), "new");
  assert.equal(set.connection("b").status, "online");
  assert.equal(world.clients.filter((c) => c.machineId === "b").at(-1).token, "new");
  set.dispose();
});

test("members found through network.status are added, connected and forgotten when removed anywhere", async () => {
  const { world, set, creds, store, cache } = setup({
    records: [rec("a", [tailnet("http://100.64.0.1:4173")], { signingKey: "key-a" })],
    credentials: { a: "tok-a" },
    localMachineId: "a",
  });
  world.host("http://100.64.0.1:4173", "a");
  world.host(T, "b");
  world.lists("a", [], []);
  world.lists("b", [project("p", "x", "r1")], [thread("t", "p", "2026-10-28T10:00:00Z")]);
  let members = [card("a"), card("b", { name: "satyamas", os: "windows" })];
  world.on("a", "network.status", () => ({ self_machine: card("a"), members }));
  world.on("a", "network.routes", () => ({ routes: [tailnet(T)] }));
  world.on("a", "network.client_grant", () => ({ token: "tok-b", scopes: [], routes: [tailnet(T)], signing_key: "key-b" }));
  await set.ensureAll();
  await set.flush();
  assert.deepEqual(set.connections().map((c) => c.record.machineId), ["a", "b"]);
  const b = set.connection("b");
  assert.equal(b.record.name, "satyamas");
  assert.equal(b.record.member, true);
  assert.equal(b.status, "online");
  assert.ok(cache.get("b"));
  assert.ok(store.records.some((r) => r.machineId === "b"));

  // A list that does not contain the machine that served it is not trusted.
  members = [card("b")];
  await set.syncMembers();
  assert.ok(set.connection("b"));

  // Removed anywhere: gone here, with its token and cached lists.
  members = [card("a")];
  await set.syncMembers();
  await set.flush();
  assert.equal(set.connection("b"), undefined);
  assert.equal(creds.tokens.has("b"), false);
  assert.equal(cache.get("b"), undefined);
  assert.deepEqual(store.records.map((r) => r.machineId), ["a"]);
  assert.throws(() => set.clientFor("b"), UnknownMachineError);
  assert.ok(world.clients.find((c) => c.machineId === "b").client.closed);
  set.dispose();
});

test("members that are not in the network are never removed by a sync", async () => {
  const { world, set } = setup({
    records: [
      rec("a", [tailnet("http://100.64.0.1:4173")], { signingKey: "key-a" }),
      rec("old", [advertised("https://old.example.com")], { member: false, legacyProfileId: "p1" }),
    ],
    credentials: { a: "tok-a", old: "tok-old" },
  });
  world.host("http://100.64.0.1:4173", "a");
  world.host("https://old.example.com", "old", { features: [] });
  world.lists("a", [], []);
  world.lists("old", [], []);
  world.on("a", "network.status", () => ({ self_machine: card("a"), members: [card("a")] }));
  await set.ensureAll();
  assert.ok(set.connection("old"));
  // A daemon older than the network has no identity document: it is reached on its environment id alone, and shown as needing an update.
  assert.equal(world.probes.some((u) => u.startsWith("https://old.example.com")), false);
  assert.equal(set.connection("old").status, "needs-update");
  set.dispose();
});

test("moving to a better route keeps the client, its subscriptions and their cursors", async () => {
  const { world, set } = setup({
    records: [rec("b", [tailnet(T), advertised(A)], { signingKey: "key-b" })],
    credentials: { b: "tok-b" },
  });
  world.host(A, "b");
  world.lists("b", [], []);
  await set.ensureAll();
  assert.equal(set.connection("b").route.url, A);
  const client = set.clientFor("b");
  const seen = [];
  const sub = client.subscribeEvents({ project_id: "p" }, (event) => seen.push(event.seq));
  const onA = world.clients.at(-1).client;
  onA.emit(4);
  onA.emit(5);
  let notified = 0;
  client.onNotification("threads.changed", () => notified++);
  onA.notify("threads.changed", {});

  world.host(T, "b"); // the tailnet comes back
  await set.networkChanged();
  const onT = world.clients.at(-1).client;
  assert.equal(world.clients.at(-1).url, T);
  assert.equal(set.connection("b").route.url, T);
  assert.equal(set.clientFor("b"), client, "the same client object");
  assert.equal(onT.subscriptions.length, 1);
  assert.equal(onT.subscriptions[0].params.after_seq, 5, "replay resumes where the old connection stopped");
  assert.equal(onT.subscriptions[0].params.project_id, "p");
  assert.equal(onA.closed, true);
  assert.equal(onA.subscriptions.length, 0);
  onT.emit(6);
  onT.notify("threads.changed", {});
  assert.deepEqual(seen, [4, 5, 6]);
  assert.equal(notified, 2);
  assert.equal(sub.lastSeq, 6);
  sub.unsubscribe();
  assert.equal(onT.subscriptions.length, 0);
  set.dispose();
});

test("failing probes for a better route leave the working one alone", async () => {
  const { world, set, clock } = setup({
    records: [rec("b", [tailnet(T), advertised(A)], { signingKey: "key-b" })],
    credentials: { b: "tok-b" },
  });
  world.host(A, "b");
  world.lists("b", [], []);
  await set.ensureAll();
  const first = world.clients.length;
  await clock.advance(5 * 60_000 + 1);
  assert.ok(world.probes.filter((u) => u.startsWith(T)).length >= 2, "the tailnet was probed again on the 5 minute tick");
  assert.equal(world.clients.length, first);
  assert.equal(set.connection("b").status, "online");
  set.dispose();
});

test("a connection that stays down fails over to the next route after the grace period", async () => {
  const { world, set, clock } = setup({
    records: [rec("b", [tailnet(T), advertised(A)], { signingKey: "key-b" })],
    credentials: { b: "tok-b" },
  });
  const host = world.host(T, "b");
  world.host(A, "b");
  world.lists("b", [], []);
  await set.ensureAll();
  assert.equal(set.connection("b").route.url, T);
  const onT = world.clients.at(-1).client;
  host.online = false;
  onT.setStatus("reconnecting", "Connection interrupted");
  assert.equal(set.connection("b").status, "offline");
  assert.throws(() => set.clientFor("b"), OfflineError);
  await clock.advance(7_000);
  assert.equal(set.connection("b").route?.url, undefined, "still inside the grace period");
  await clock.advance(2_000);
  assert.equal(set.connection("b").status, "online");
  assert.equal(set.connection("b").route.url, A);
  assert.equal(onT.closed, true);
  set.dispose();
});

test("a machine that stays unreachable is retried with backoff and is back when it answers", async () => {
  const { world, set, clock } = setup({ records: [rec("b", [tailnet(T)], { signingKey: "key-b" })], credentials: { b: "tok-b" } });
  world.lists("b", [], []);
  await set.ensureAll();
  assert.equal(set.connection("b").status, "offline");
  const attempts = () => world.probes.length;
  const first = attempts();
  await clock.advance(2_000);
  assert.equal(attempts(), first + 1);
  await clock.advance(3_000);
  assert.equal(attempts(), first + 1, "next retry waits 4 s");
  world.host(T, "b");
  await clock.advance(1_000);
  assert.equal(set.connection("b").status, "online");
  set.dispose();
});

test("an offline machine keeps its cached lists, greyed with when it was last seen", async () => {
  const cacheText = JSON.stringify({
    v: 1,
    machines: [{ machineId: "b", savedAt: 1_000, projects: [project("p1", "x", "r1"), project("p2", "y", "r2")], threads: [thread("old", "p1", "2026-10-27T10:00:00Z")] }],
  });
  const { world, set } = setup({
    records: [rec("a", [tailnet("http://100.64.0.1:4173")], { signingKey: "key-a" }), rec("b", [tailnet(T)], { signingKey: "key-b" }), rec("c", [tailnet("http://100.64.0.9:4173")], { signingKey: "key-c" })],
    credentials: { a: "tok-a", b: "tok-b", c: "tok-c" },
    cacheText,
    localMachineId: "a",
  });
  world.host("http://100.64.0.1:4173", "a");
  world.lists("a", [project("pa", "x", "r1")], [thread("ta", "pa", "2026-10-28T09:00:00Z")]);
  await set.ensureAll();
  const view = set.merged();
  const b = view.machines.find((m) => m.machineId === "b");
  assert.equal(b.offline, true);
  assert.equal(b.lastSeenAt, 1_000);
  assert.equal(b.status, "offline");
  // x is the same repository on a and b: one project, with b's cached copy flagged offline.
  const x = view.projects.find((p) => p.key === "root:r1");
  assert.deepEqual(x.instances.map((i) => [i.machineId, i.offline]), [["a", false], ["b", true]]);
  assert.ok(view.projects.find((p) => p.key === "root:r2"));
  const cached = view.threads.byKey.get("b\u0001old");
  assert.equal(cached.offline, true);
  assert.equal(cached.lastSeenAt, 1_000);
  assert.equal(view.threads.byKey.get("a\u0001ta").offline, false);
  assert.throws(() => set.clientFor("b"), (error) => error instanceof OfflineError && error.cached === true && error.machineId === "b");
  assert.throws(() => set.clientFor("c"), (error) => error instanceof OfflineError && error.cached === false);
  set.dispose();
});

test("when an offline machine comes back its fresh lists replace the cached ones", async () => {
  const cacheText = JSON.stringify({
    v: 1,
    machines: [{ machineId: "b", savedAt: 1_000, projects: [project("p1", "x", "r1")], threads: [thread("gone", "p1", "2026-10-27T10:00:00Z")] }],
  });
  const { world, set, clock, cache } = setup({ records: [rec("b", [tailnet(T)], { signingKey: "key-b" })], credentials: { b: "tok-b" }, cacheText });
  await set.ensureAll();
  assert.equal(set.merged().threads.all.length, 1);
  world.host(T, "b");
  world.lists("b", [project("p1", "x", "r1")], [thread("fresh", "p1", "2026-10-28T10:00:00Z")]);
  await set.networkChanged();
  await clock.flush();
  const view = set.merged();
  assert.deepEqual(view.threads.all.map((t) => [t.thread.id, t.offline]), [["fresh", false]]);
  assert.deepEqual(cache.get("b").threads.map((t) => t.id), ["fresh"]);
  assert.equal(cache.get("b").savedAt, clock.now());
  assert.equal(set.connection("b").lastSeenAt, clock.now());
  set.dispose();
});

test("a machine going offline keeps its last lists and cached copy", async () => {
  const { world, set, clock, cache } = setup({ records: [rec("b", [tailnet(T)], { signingKey: "key-b" })], credentials: { b: "tok-b" } });
  const host = world.host(T, "b");
  world.lists("b", [project("p1", "x", "r1")], [thread("t", "p1", "2026-10-28T10:00:00Z")]);
  await set.ensureAll();
  assert.equal(set.merged().threads.all[0].offline, false);
  host.online = false;
  world.clients.at(-1).client.setStatus("failed", "gone");
  await clock.flush();
  const view = set.merged();
  assert.equal(view.threads.all[0].offline, true);
  assert.equal(view.threads.all[0].lastSeenAt, clock.now());
  assert.ok(cache.get("b"));
  set.dispose();
});

test("a paused machine is not talked to and is listed from its cache", async () => {
  const cacheText = JSON.stringify({ v: 1, machines: [{ machineId: "b", savedAt: 5, projects: [project("p1", "x", "r1")], threads: [] }] });
  const { world, set } = setup({ records: [rec("b", [tailnet(T)], { signingKey: "key-b", paused: true })], credentials: { b: "tok-b" }, cacheText });
  world.host(T, "b");
  world.lists("b", [], []);
  await set.ensureAll();
  assert.equal(set.connection("b").status, "paused");
  assert.equal(world.probes.length, 0);
  assert.equal(set.merged().projects.length, 1);
  assert.equal(set.merged().machines[0].offline, true);
  await set.setPaused("b", false);
  assert.equal(set.connection("b").status, "online");
  assert.equal(world.probes.length, 1);
  set.dispose();
});

test("handleFor keeps subscriptions made before the machine is up", async () => {
  const { world, set } = setup({ records: [rec("b", [tailnet(T)], { signingKey: "key-b" })], credentials: { b: "tok-b" } });
  world.host(T, "b");
  world.lists("b", [], []);
  await set.load?.();
  const handle = set.handleFor("b");
  const seen = [];
  handle.subscribeEvents({}, (event) => seen.push(event.seq));
  await assert.rejects(handle.call("daemon.info", {}), OfflineError);
  await set.ensureAll();
  const live = world.clients.at(-1).client;
  assert.equal(live.subscriptions.length, 1);
  live.emit(1);
  assert.deepEqual(seen, [1]);
  assert.equal(await handle.call("projects.list", {}).then((r) => r.projects.length), 0);
  set.dispose();
});

test("thread and project owners are looked up by machine, even when ids collide", async () => {
  const { world, set } = setup({
    records: [rec("mac", [tailnet("http://100.64.0.1:4173")], { signingKey: "key-mac" }), rec("pc", [tailnet(T)], { signingKey: "key-pc" })],
    credentials: { mac: "t1", pc: "t2" },
    localMachineId: "mac",
  });
  world.host("http://100.64.0.1:4173", "mac");
  world.host(T, "pc");
  world.lists("mac", [project("p", "x", "r1")], [thread("shared", "p", "2026-10-28T10:00:00Z"), thread("only-mac", "p", "2026-10-28T10:00:00Z")]);
  world.lists("pc", [project("p", "x", "r1")], [thread("shared", "p", "2026-10-28T11:00:00Z"), thread("only-pc", "p", "2026-10-28T11:00:00Z")]);
  await set.ensureAll();
  assert.equal(set.machineOfThread("only-pc"), "pc");
  assert.equal(set.machineOfThread("only-mac"), "mac");
  assert.equal(set.machineOfThread("shared"), "mac", "ambiguous ids prefer the machine the user is at");
  assert.equal(set.machineOfThread("shared", "pc"), "pc", "a hint decides");
  assert.deepEqual(set.machinesOfThread("shared").sort(), ["mac", "pc"]);
  assert.equal(set.machineOfThread("nope"), undefined);
  assert.equal(set.machineOfProject("p", "pc"), "pc");

  const view = set.merged();
  assert.equal(view.showGlyphs, true);
  assert.deepEqual(view.machines.map((m) => [m.machineId, m.isLocal, m.showGlyph]), [["mac", true, false], ["pc", false, true]]);
  assert.equal(view.projects.length, 1, "one logical project for the same repository");
  assert.equal(view.threads.all.length, 4);
  assert.equal(set.merged(), view, "the view is reused until something changes");
  set.dispose();
});

test("a lone machine shows no glyphs", async () => {
  const { world, set } = setup({ records: [rec("mac", [tailnet("http://100.64.0.1:4173")], { signingKey: "key-mac" })], credentials: { mac: "t1" }, localMachineId: "mac" });
  world.host("http://100.64.0.1:4173", "mac");
  world.lists("mac", [], []);
  await set.ensureAll();
  const view = set.merged();
  assert.equal(view.showGlyphs, false);
  assert.equal(view.machines[0].showGlyph, false);
  set.dispose();
});

test("ingest replaces a machine's lists with a read the app made and caches them", async () => {
  const { world, set, cache } = setup({ records: [rec("b", [tailnet(T)], { signingKey: "key-b" })], credentials: { b: "tok-b" } });
  world.host(T, "b");
  world.lists("b", [], []);
  await set.ensureAll();
  let changes = 0;
  const off = set.onChange(() => changes++);
  set.ingest("b", { threads: [thread("t", "p", "2026-10-28T10:00:00Z")] });
  assert.equal(set.merged().threads.all.length, 1);
  assert.equal(cache.get("b").threads.length, 1);
  assert.ok(changes > 0);
  off();
  set.ingest("b", { threads: [] });
  assert.equal(set.merged().threads.all.length, 0);
  set.dispose();
});

test("adding and removing a machine updates the store, credentials and cache", async () => {
  const { world, set, store, creds, cache } = setup();
  world.host(T, "b");
  world.lists("b", [project("p", "x", "r1")], []);
  const connection = await set.addMachine({ machineId: "b", name: "satyamas", routes: [tailnet(T)], signingKey: "key-b" }, "tok-b");
  assert.equal(connection.status, "online");
  assert.equal(creds.tokens.get("b"), "tok-b");
  await set.flush();
  assert.equal(store.records[0].name, "satyamas");
  await set.refresh();
  assert.ok(cache.get("b"));
  await set.removeMachine("b");
  assert.equal(creds.tokens.has("b"), false);
  assert.equal(cache.get("b"), undefined);
  await set.flush();
  assert.deepEqual(store.records, []);
  assert.deepEqual(set.connections(), []);
  set.dispose();
});

test("dispose closes every connection and stops the timers", async () => {
  const { world, set, clock } = setup({ records: [rec("b", [tailnet(T)], { signingKey: "key-b" })], credentials: { b: "tok-b" } });
  world.host(T, "b");
  world.lists("b", [], []);
  await set.ensureAll();
  set.dispose();
  assert.equal(world.clients.at(-1).client.closed, true);
  await clock.advance(10 * 60_000);
  assert.equal(clock.pending(), 0);
});

test("lists held in memory are bounded to the newest threads per machine", async () => {
  const { world, set } = setup({ records: [rec("b", [tailnet(T)], { signingKey: "key-b" })], credentials: { b: "tok-b" }, maxThreadsPerMachine: 5 });
  world.host(T, "b");
  const many = Array.from({ length: 20 }, (_, i) => thread(`t${i}`, "p", new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString()));
  world.lists("b", [project("p", "x", "r1")], many);
  await set.ensureAll();
  assert.deepEqual(set.merged().threads.all.map((t) => t.thread.id), ["t19", "t18", "t17", "t16", "t15"]);
  set.dispose();
});

test("a connection that fails leaves online at once, before the retry finishes", async () => {
  const { world, set, clock } = setup({ records: [rec("b", [tailnet(T)], { signingKey: "key-b" })], credentials: { b: "tok-b" } });
  const host = world.host(T, "b");
  world.lists("b", [], []);
  await set.ensureAll();
  host.online = false;
  world.clients.at(-1).client.setStatus("failed", "Access was revoked");
  assert.equal(set.connection("b").status, "offline");
  assert.throws(() => set.clientFor("b"), OfflineError);
  await clock.flush();
  set.dispose();
});
