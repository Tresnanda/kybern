import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
// Extensionless imports in the app's sources resolve to `.ts`, as in the other state tests.
registerHooks({ resolve(specifier, context, next) {
  const url = specifier.startsWith(".") && context.parentURL ? new URL(specifier, context.parentURL) : null;
  if (url?.protocol === "file:" && !/\.[a-z]+$/i.test(url.pathname) && existsSync(fileURLToPath(url) + ".ts")) return { shortCircuit: true, url: url.href + ".ts" };
  return next(specifier, context);
} });
const { MachineHub } = await import("../src/machines/hub.ts");
const { LEGACY_PREFIX, computerOfRecord, recordOfComputer, recordsFromComputers, routeUrl } = await import("../src/machines/records.ts");
const { OfflineError } = await import("../../../packages/kybern-client/src/machines.ts");
const { wellKnownProofMessage } = await import("../../../packages/kybern-client/src/machineRoutes.ts");
const { MachineCache } = await import("../../../packages/kybern-client/src/machineCache.ts");
const { FakeClient, fakeWorld, manualClock, memoryCredentials, memoryStore } = await import("../../../packages/kybern-client/tests/machine-fakes.mjs");

const project = (id, name, root) => ({ id, name, path: `/w/${name}`, is_git: true, brief_in_all_threads: false, repo: { root_commit: root }, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" });
const thread = (id, project_id, updated_at) => ({ id, project_id, title: id, status: "idle", pinned: false, updated_at });
const rec = (machineId, extra = {}) => ({ machineId, name: machineId, routes: [{ kind: "direct_advertised", url: `http://${machineId}.tail.ts.net:4173` }], member: false, ...extra });
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

const hubs = [];
function setup({ records = [], credentials = {}, transport, clock = manualClock() } = {}) {
  const world = fakeWorld(clock);
  const store = memoryStore(records);
  const creds = memoryCredentials(credentials);
  const timers = [];
  const rekeys = [];
  const hub = new MachineHub({
    store, credentials: creds, cache: new MachineCache(), deviceId: "phone-1", clock,
    transport: transport ?? world.transport,
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
    onRekey: (oldId, newId) => rekeys.push([oldId, newId]),
  });
  hubs.push(hub);
  return { hub, world, store, creds, clock, rekeys, runTimers: () => timers.splice(0).forEach((fn) => fn()) };
}
/** The app's own connection to the computer it is at. */
function app(world, machineId, { features = [], open = true, handlers = {} } = {}) {
  const host = { machineId, online: true, info: { machine_id: machineId, environment_id: machineId, version: "0.20.0", features } };
  world.handlers[machineId] = { ...handlers, ...world.handlers[machineId] };
  const client = new FakeClient(world, host, { url: `ws://${machineId}.tail.ts.net:4173/ws` }, "app-token");
  if (open) { client.info = host.info; client.status = "open"; }
  return client;
}
async function openPrimary(hub, client, profile, lists) {
  await hub.beginPrimary(client, profile);
  if (lists) hub.setPrimaryLists(client, () => lists);
  client.info = client.info ?? { ...client.host.info };
  client.setStatus("open");
  await hub.primaryOpened(client);
  await settle();
}
test.afterEach(() => { for (const hub of hubs.splice(0)) hub.dispose(); });

test("saved computers become machine records and back, with stand-in ids only for computers the phone never heard from", () => {
  const computers = [{ id: "env-1", name: "Mac", url: "ws://10.0.0.1:4173/ws", token: "t1", environmentId: "env-1" }, { id: "old", name: "Old", url: "ws://10.0.0.2:4173/ws", token: "t2" }];
  const records = recordsFromComputers(computers);
  assert.deepEqual(records.map((r) => [r.machineId, r.member]), [["env-1", false], [`${LEGACY_PREFIX}old`, false]]);
  assert.deepEqual(records[1].routes, [{ kind: "direct_advertised", url: "http://10.0.0.2:4173" }]);
  assert.equal(routeUrl("wss://mac.tail.ts.net/ws"), "https://mac.tail.ts.net");
  assert.deepEqual(recordOfComputer({ id: "x", name: "X", url: "", token: "t" }).routes, []);
  assert.deepEqual(computerOfRecord(records[0], "t1"), { id: "env-1", name: "Mac", url: "ws://10.0.0.1:4173/ws", token: "t1", environmentId: "env-1" });
  assert.deepEqual(computerOfRecord(records[1], "t2"), { id: `${LEGACY_PREFIX}old`, name: "Old", url: "ws://10.0.0.2:4173/ws", token: "t2" });
  assert.equal(computerOfRecord(records[0], null), undefined, "no token, no computer to open");
  assert.equal(computerOfRecord({ ...records[0], routes: [] }, "t"), undefined, "a machine only reachable through a member is the set's");
});

test("the computer the phone is at joins the set at once, offline until it opens, and is never dialed or closed by the set", async () => {
  const { hub, world, store } = setup({ records: [rec("mac")], credentials: { mac: "tok" } });
  const client = app(world, "mac", { open: false });
  await hub.beginPrimary(client, { machineId: "mac", name: "Mac" });
  assert.equal(hub.localMachineId, "mac");
  assert.equal(hub.set.connection("mac").status, "offline");
  assert.equal(world.clients.length, 0, "the set opened nothing for it");
  client.info = { ...client.host.info }; client.setStatus("open");
  await hub.primaryOpened(client);
  await settle();
  assert.equal(hub.set.connection("mac").status, "needs-update");
  assert.equal(hub.primaryMachineId, "mac");
  assert.deepEqual(client.calls, [], "the set reads nothing the app already reads");
  hub.releasePrimary();
  client.close();
  client.setStatus("closed");
  await settle();
  assert.equal(hub.set.connection("mac").status, "offline", "released, not paused");
  assert.ok(!hub.set.connection("mac").record.paused);
  assert.throws(() => hub.clientFor("mac"), OfflineError);
  assert.equal(world.clients.length, 0);
  assert.equal(store.records.length, 1);
});

test("a stand-in id becomes the daemon's real id: record, token and the app's saved computer follow", async () => {
  const { hub, world, store, creds, rekeys } = setup({ records: [rec(`${LEGACY_PREFIX}old`)], credentials: { [`${LEGACY_PREFIX}old`]: "tok" } });
  const client = app(world, "mac-1", { open: false });
  await openPrimary(hub, client, { machineId: `${LEGACY_PREFIX}old`, name: "Old" });
  assert.deepEqual(hub.connections().map((c) => c.record.machineId), ["mac-1"]);
  assert.deepEqual(rekeys, [[`${LEGACY_PREFIX}old`, "mac-1"]]);
  assert.equal(creds.tokens.get("mac-1"), "tok");
  assert.equal(creds.tokens.has(`${LEGACY_PREFIX}old`), false);
  assert.equal(hub.primaryMachineId, "mac-1");
  await hub.set.flush();
  assert.deepEqual(store.records.map((r) => r.machineId), ["mac-1"]);
});

test("the primary's lists reach the set only once a second machine is listed, once per burst", async () => {
  const { hub, world, runTimers } = setup({ records: [rec("mac")], credentials: { mac: "tok" } });
  world.host("http://vps.tail.ts.net:4173", "vps", { features: [] });
  world.lists("vps", [], []);
  const p1 = project("p1", "kybern", "r1");
  let lists = { projects: [p1], threads: [thread("t1", "p1", "2026-10-02T00:00:00Z")], activity: [] };
  await openPrimary(hub, app(world, "mac"), { machineId: "mac", name: "Mac" }, undefined);
  const client = hub.primaryClient;
  hub.setPrimaryLists(client, () => lists);
  const off = hub.subscribe(() => {});
  runTimers();
  const first = hub.view();
  assert.deepEqual(first.threads.all, [], "one machine: the screens read the computer's own lists, nothing was merged");
  lists = { ...lists, threads: [thread("t1", "p1", "2026-10-02T00:00:00Z"), thread("t2", "p1", "2026-10-03T00:00:00Z")] };
  hub.primaryListsChanged(client);
  runTimers();
  assert.equal(hub.view(), first);
  // A second machine arrives: the primary's latest lists are merged with its.
  await hub.addMachine({ machineId: "vps", name: "VPS", routes: [{ kind: "direct_advertised", url: "http://vps.tail.ts.net:4173" }] }, "tok-vps");
  await settle();
  runTimers();
  const view = hub.view();
  assert.deepEqual(view.threads.all.map((t) => [t.machineId, t.thread.id]), [["mac", "t2"], ["mac", "t1"]]);
  assert.equal(view.showGlyphs, true);
  // A burst of changes is one write.
  const seen = [];
  const stop = hub.set.onChange((event) => seen.push(event.type));
  for (let i = 0; i < 5; i++) hub.primaryListsChanged(client);
  runTimers();
  assert.equal(seen.filter((type) => type === "lists").length, 1);
  stop();
  off();
});

test("other machines are the set's own: dialed with their saved token, merged, and requests route by thread and project", async () => {
  const { hub, world, runTimers } = setup({ records: [rec("mac"), rec("vps")], credentials: { mac: "tok-mac", vps: "tok-vps" } });
  const vpsHost = world.host("http://vps.tail.ts.net:4173", "vps", { features: [] });
  world.lists("vps", [project("p9", "kybern", "r1"), project("p10", "site", "r2")], [thread("t-v", "p9", "2026-10-03T00:00:00Z"), thread("t-same", "p9", "2026-10-01T00:00:00Z")]);
  const mac = app(world, "mac");
  await openPrimary(hub, mac, { machineId: "mac", name: "Mac" }, { projects: [project("p1", "kybern", "r1")], threads: [thread("t-m", "p1", "2026-10-02T00:00:00Z"), thread("t-same", "p1", "2026-10-04T00:00:00Z")], activity: [] });
  runTimers();
  await settle();
  assert.deepEqual(world.clients.map((c) => [c.machineId, c.token]), [["vps", "tok-vps"]]);
  const view = hub.view();
  assert.equal(view.showGlyphs, true);
  assert.deepEqual(view.machines.map((m) => [m.machineId, m.showGlyph, m.isLocal]), [["mac", false, true], ["vps", true, false]]);
  assert.deepEqual(view.projects.map((p) => [p.name, p.instances.map((i) => i.machineId)]), [["kybern", ["mac", "vps"]], ["site", ["vps"]]]);
  assert.deepEqual(view.threads.all.map((t) => [t.machineId, t.thread.id]), [["mac", "t-same"], ["vps", "t-v"], ["mac", "t-m"], ["vps", "t-same"]]);
  assert.equal(hub.routeFor({ thread_id: "t-v" }), "vps");
  assert.equal(hub.routeFor({ thread_id: "t-same" }), "mac", "the machine the phone is at wins a shared id");
  assert.equal(hub.routeFor({ project_id: "p10" }), "vps");
  assert.equal(hub.routeFor({ thread_id: "new-chat", project_id: "p10" }), "vps", "an unlisted thread follows its project");
  assert.equal(hub.routeFor({ thread_id: "new-chat" }), undefined, "an unlisted thread with no project is the primary's");
  assert.equal(hub.routeFor({}), undefined);
  assert.equal(hub.clientForProject("p10"), hub.clientFor("vps"));
  assert.equal(hub.machineOfThread("new-chat"), "mac");
  assert.deepEqual(mac.calls, []);
  // A machine going away keeps its cached lists, greyed.
  vpsHost.online = false;
  world.clients[0].client.setStatus("closed");
  await settle();
  assert.equal(hub.view().threads.byKey.get("vps\u0001t-v").offline, true);
  assert.throws(() => hub.clientFor("vps"), OfflineError);
});

test("one pairing reaches every machine: a member mints this device's token for the others", async () => {
  const { hub, world, creds, runTimers } = setup({ records: [rec("mac", { member: true })], credentials: { mac: "tok-mac" } });
  world.host("http://vps.tail.ts.net:4173", "vps", { features: ["network.v1"] });
  world.lists("vps", [], []);
  const card = (id, extra = {}) => ({ machine_id: id, name: id, os: "linux", status: "online", ...extra });
  const mac = app(world, "mac", { features: ["network.v1"], handlers: {
    "network.status": () => ({ enabled: true, self_machine: card("mac", { is_self: true }), members: [card("mac"), card("vps")], found: [], outbox: {}, tailscale: {} }),
    "network.routes": () => ({ routes: [{ kind: "direct_advertised", url: "http://vps.tail.ts.net:4173" }] }),
    "network.client_grant": ({ machine_id, device_id }) => {
      assert.equal(device_id, "phone-1");
      return { token: `minted-${machine_id}`, scopes: [], routes: [{ kind: "direct_advertised", url: "http://vps.tail.ts.net:4173" }], signing_key: null };
    },
  } });
  await openPrimary(hub, mac, { machineId: "mac", name: "Mac" });
  // Members verify with an identity document; this one is a daemon the fake world cannot sign for, so the machine stays listed.
  runTimers();
  await settle();
  assert.ok(hub.set.connection("mac").record.member, "a daemon that speaks the network protocol is a member");
  assert.ok(hub.connections().some((c) => c.record.machineId === "vps"), "the network's other member is listed");
  assert.ok(mac.calls.some(([method]) => method === "network.status"));
  assert.equal(hub.memberClient()?.endpoint.environmentId, "mac");
  assert.equal(hub.memberClient("mac"), undefined, "the machine being removed is never asked");
  assert.equal(creds.tokens.get("vps"), "minted-vps");
});

test("a member's identity document is checked with a real Ed25519 signature, and an impostor is refused before any token is sent", async () => {
  const secret = ed25519.utils.randomSecretKey();
  const key = b64(ed25519.getPublicKey(secret));
  const impostor = ed25519.utils.randomSecretKey();
  let signer = secret;
  let tamper = false;
  const world = { clients: [] };
  const clock = manualClock();
  const transport = {
    nonce: () => "nonce-1",
    probe: async (url) => {
      const parsed = new URL(url);
      const at = new Date(clock.now()).toISOString();
      const parts = { nonce: parsed.searchParams.get("nonce"), machineId: "vps", at, host: parsed.host };
      const proof = ed25519.sign(wellKnownProofMessage(parts), signer);
      if (tamper) proof[0] ^= 1;
      return { machine_id: "vps", name: "vps", os: "linux", signing_key: key, at, proof: b64(proof) };
    },
    createClient: ({ record, token }) => {
      const client = new FakeClient({ handlers: {} }, { machineId: record.machineId, online: true, info: { machine_id: record.machineId, features: ["network.v1"] } }, { url: "ws://vps/ws" }, token);
      world.clients.push({ token, client });
      return client;
    },
  };
  const vps = rec("vps", { member: true });
  const good = setup({ records: [vps], credentials: { vps: "tok" }, transport, clock });
  await good.hub.set.ensureAll();
  assert.equal(world.clients.length, 1, "a genuine signature connects");
  assert.equal(good.hub.set.connection("vps").record.signingKey, key, "the key is pinned on first use");

  world.clients.length = 0;
  signer = impostor; // someone who repeats the public key but cannot sign
  const bad = setup({ records: [vps], credentials: { vps: "tok" }, transport, clock });
  await bad.hub.set.ensureAll();
  assert.deepEqual(world.clients, [], "no token went to an address that could not sign");
  assert.equal(bad.hub.set.connection("vps").error.code, "identity_mismatch");

  signer = secret; tamper = true;
  const flipped = setup({ records: [vps], credentials: { vps: "tok" }, transport, clock });
  await flipped.hub.set.ensureAll();
  assert.deepEqual(world.clients, []);
  assert.equal(flipped.hub.set.connection("vps").error.code, "identity_mismatch");
});

test("a machine can be paused, resumed and removed; removing forgets its token, cache and record", async () => {
  const { hub, world, creds, store, runTimers } = setup({ records: [rec("mac"), rec("vps")], credentials: { mac: "tok-mac", vps: "tok-vps" } });
  world.host("http://vps.tail.ts.net:4173", "vps", { features: [] });
  world.lists("vps", [project("p9", "kybern", "r1")], [thread("t-v", "p9", "2026-10-03T00:00:00Z")]);
  await openPrimary(hub, app(world, "mac"), { machineId: "mac", name: "Mac" }, { projects: [], threads: [], activity: [] });
  runTimers();
  await settle();
  assert.equal(hub.set.connection("vps").status, "needs-update");
  await hub.setPaused("vps", true);
  assert.equal(hub.set.connection("vps").status, "paused");
  assert.equal(hub.view().threads.byKey.get("vps\u0001t-v").offline, true, "still listed from its cache");
  await hub.setPaused("vps", false);
  await settle();
  assert.equal(hub.set.connection("vps").status, "needs-update");
  await hub.removeMachine("vps");
  await hub.set.flush();
  assert.deepEqual(hub.connections().map((c) => c.record.machineId), ["mac"]);
  assert.equal(creds.tokens.has("vps"), false);
  assert.deepEqual(store.records.map((r) => r.machineId), ["mac"]);
});

test("a computer saved for the phone to be at is paused until its connection is adopted, so the set never dials it", async () => {
  const { hub, world, creds } = setup();
  await hub.saveComputer({ machineId: "mac", name: "Mac", routes: [{ kind: "direct_advertised", url: "http://mac.tail.ts.net:4173" }] }, "tok");
  assert.equal(creds.tokens.get("mac"), "tok");
  assert.equal(hub.set.connection("mac").status, "paused");
  assert.equal(world.clients.length, 0);
  await hub.beginPrimary(app(world, "mac", { open: false }), { machineId: "mac", name: "Mac" });
  assert.equal(hub.set.connection("mac").record.paused, false);
  assert.equal(world.clients.length, 0);
});

test("a machine added by code is connected by the set with its token", async () => {
  const { hub, world, creds } = setup();
  world.host("http://vps.tail.ts.net:4173", "vps", { features: [] });
  world.lists("vps", [], []);
  await hub.addMachine({ machineId: "vps", name: "VPS", routes: [{ kind: "direct_advertised", url: "http://vps.tail.ts.net:4173" }] }, "tok-vps");
  await settle();
  assert.equal(creds.tokens.get("vps"), "tok-vps");
  assert.deepEqual(world.clients.map((c) => [c.machineId, c.token]), [["vps", "tok-vps"]]);
});
