import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
registerHooks({ resolve(specifier, context, next) {
  const url = specifier.startsWith(".") && context.parentURL ? new URL(specifier, context.parentURL) : null;
  if (url?.protocol === "file:" && !/\.[a-z]+$/i.test(url.pathname) && existsSync(fileURLToPath(url) + ".ts")) return { shortCircuit: true, url: url.href + ".ts" };
  return next(specifier, context);
} });
const { buildLists, singleMachineLists } = await import("../src/state/machineLists.ts");
const { filterThreads, groupByProject, DEFAULT_FILTER } = await import("../src/state/threadList.ts");
const { lastSeenText, machineStatusLine, machinesSummary } = await import("../src/machines/labels.ts");
const { MachineSet } = await import("../../../packages/kybern-client/src/machines.ts");
const { MachineCache } = await import("../../../packages/kybern-client/src/machineCache.ts");
const { FakeClient, fakeWorld, manualClock, memoryCredentials, memoryStore, verifyProof } = await import("../../../packages/kybern-client/tests/machine-fakes.mjs");

const project = (id, name, root) => ({ id, name, path: `/w/${name}`, is_git: true, brief_in_all_threads: false, repo: { root_commit: root }, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" });
const thread = (id, project_id, updated_at, extra = {}) => ({ id, project_id, title: id, status: "idle", pinned: false, provider: { kind: "codex" }, updated_at, ...extra });
const activity = (thread_id) => ({ thread_id, active_agents: 1, active_processes: 0, active_monitors: 0 });

async function twoMachines() {
  const clock = manualClock();
  const set = new MachineSet({ store: memoryStore([]), credentials: memoryCredentials(), deviceId: "d", verifyProof, clock, cache: new MachineCache(), localMachineId: "mac" });
  const world = fakeWorld(clock);
  const open = async (id, lists, acts = []) => {
    const host = { machineId: id, online: true, info: { machine_id: id, environment_id: id, features: [] } };
    const client = new FakeClient(world, host, { url: `ws://${id}/ws` }, "t");
    client.info = host.info; client.status = "open";
    await set.adoptConnection({ machineId: id, name: id === "mac" ? "MacBook" : "satyamas" }, client, { autoRefresh: false, lists: { ...lists, activity: acts } });
    return client;
  };
  const mac = await open("mac", { projects: [project("p1", "kybern", "r1"), project("p2", "web", "r2")], threads: [thread("t-m", "p1", "2026-10-02T00:00:00Z"), thread("t-m2", "p2", "2026-10-01T12:00:00Z", { project_id: "p2" })] });
  const win = await open("win", { projects: [project("w9", "kybern", "r1"), project("w10", "game", "r3")], threads: [thread("t-w", "w9", "2026-10-03T00:00:00Z"), thread("t-g", "w10", "2026-10-02T12:00:00Z")] }, [activity("t-w")]);
  set.setLocalMachine("mac");
  return { set, mac, win, world };
}
const local = { projects: [], threads: [], activity: [] };

test("with one machine the lists are the computer's own, untouched", async () => {
  const { set } = await twoMachines();
  await set.removeMachine("win");
  const own = { projects: [project("p1", "kybern", "r1")], threads: [thread("t", "p1", "2026-10-02T00:00:00Z")], activity: [activity("t")] };
  const lists = buildLists(set.merged(), own);
  assert.equal(lists.threads, own.threads);
  assert.equal(lists.projects, own.projects);
  assert.equal(lists.showGlyphs, false);
  assert.equal(lists.machineOfThread("t"), undefined);
  assert.deepEqual(singleMachineLists(own).machines, []);
});

test("two machines: the same repository is one project, with the threads of both under it, newest first", async () => {
  const { set } = await twoMachines();
  const lists = buildLists(set.merged(), local, null, (id) => set.activityOf(id));
  assert.deepEqual(lists.projects.map((p) => p.id), ["p1", "p2", "w10"], "the machine the phone is at names a shared project; others add theirs");
  assert.deepEqual(lists.threads.map((t) => [t.id, t.project_id]), [["t-w", "p1"], ["t-g", "w10"], ["t-m", "p1"], ["t-m2", "p2"]]);
  const top = filterThreads({ threads: lists.threads, projects: lists.projects, spaceId: null, filter: DEFAULT_FILTER, isWorking: () => false });
  assert.deepEqual(groupByProject(top, lists.projects, []).map((g) => [g.name, g.threads.map((t) => t.id)]), [["kybern", ["t-w", "t-m"]], ["game", ["t-g"]], ["web", ["t-m2"]]]);
  assert.equal(lists.showGlyphs, true);
});

test("a thread's glyph shows only for machines other than the one the phone is at; activity and ownership follow the machine", async () => {
  const { set } = await twoMachines();
  const lists = buildLists(set.merged(), local, null, (id) => set.activityOf(id));
  assert.equal(lists.machineOfThread("t-m").showGlyph, false);
  const remote = lists.machineOfThread("t-w");
  assert.deepEqual([remote.machineId, remote.name, remote.showGlyph, remote.offline, remote.glyph.letter], ["win", "satyamas", true, false, "S"]);
  assert.deepEqual(lists.activity.map((a) => a.thread_id), ["t-w"]);
  assert.equal(lists.ownerOf("t-w").machineId, "win");
  assert.equal(lists.ownerOf("t-w").thread.project_id, "w9", "writes use the machine's own project id, not the display one");
  assert.equal(lists.ownerOf("nope"), undefined);
});

test("a copy of another machine's thread keeps its identity while nothing changes", async () => {
  const { set } = await twoMachines();
  const a = buildLists(set.merged(), local).threads.find((t) => t.id === "t-w");
  const b = buildLists(set.merged(), local).threads.find((t) => t.id === "t-w");
  assert.equal(a, b);
  const own = buildLists(set.merged(), local).threads.find((t) => t.id === "t-m");
  assert.equal(own.project_id, "p1");
});

test("the All machines filter keeps one machine's threads, under that machine's own projects", async () => {
  const { set } = await twoMachines();
  const lists = buildLists(set.merged(), local, "win", (id) => set.activityOf(id));
  assert.deepEqual(lists.projects.map((p) => p.id), ["w9", "w10"]);
  assert.deepEqual(lists.threads.map((t) => [t.id, t.project_id]), [["t-w", "w9"], ["t-g", "w10"]]);
  assert.deepEqual(buildLists(set.merged(), local, "gone").threads.length, 4, "an unknown machine filters nothing");
});

test("an offline machine's threads stay listed, flagged, with when it was last seen", async () => {
  const { set, win } = await twoMachines();
  win.setStatus("closed");
  const lists = buildLists(set.merged(), local);
  const seen = lists.machineOfThread("t-w");
  assert.equal(seen.offline, true);
  assert.equal(typeof seen.lastSeenAt, "number");
  assert.equal(lists.threads.length, 4);
});

test("machine sentences", () => {
  const now = Date.parse("2026-10-29T12:00:00Z");
  assert.equal(lastSeenText(now - 30_000, now), "just now");
  assert.equal(lastSeenText(now - 5 * 60_000, now), "5 min ago");
  assert.equal(lastSeenText(now - 2 * 3_600_000, now), "2 h ago");
  assert.equal(lastSeenText(now - 3 * 86_400_000, now), "3 d ago");
  assert.equal(machineStatusLine({ status: "online", version: "0.20.0" }), "Online · 0.20.0");
  assert.equal(machineStatusLine({ status: "relaying", relayVia: "VPS" }), "Relaying via VPS");
  assert.equal(machineStatusLine({ status: "offline", lastSeenAt: now - 2 * 3_600_000 }, now), "Offline · last seen 2 h ago");
  assert.equal(machineStatusLine({ status: "offline", connecting: true }), "Connecting…");
  assert.equal(machineStatusLine({ status: "offline", error: "This address answered as a different machine" }), "Offline · This address answered as a different machine");
  assert.equal(machineStatusLine({ status: "unpaired", error: "Pair this device with VPS" }), "Pair this device with VPS");
  assert.equal(machineStatusLine({ status: "paused" }), "Paused");
  assert.equal(machinesSummary(["online", "online", "offline", "online"]), "4 machines · 1 offline");
  assert.equal(machinesSummary(["online"]), "1 machine");
});


test("remote-only placement updates notify with a stable hub view and unchanged rail", async () => {
  const { setSpacePlacements, spaceProject, getSpacePlacementVersion, subscribeSpacePlacements } = await import("../../../packages/kybern-client/src/spacePlacements.ts");
  const { set } = await twoMachines();
  const view = set.merged();
  const remote = view.projects.find((p) => p.primary.project.id === "w10").primary;
  const rail = [{ id:"personal", name:"Personal", is_default:true }, { id:"work", name:"Work", is_default:false }];
  const p = spaceProject(remote.machineId, remote.project);
  setSpacePlacements(rail, [{project:p,space_id:"personal",lamport:1,signer:"mac",op_id:"one"}]);
  let observed = buildLists(view, local);
  const previousVersion = getSpacePlacementVersion();
  const stop = subscribeSpacePlacements(() => { observed = buildLists(view, local); });
  try {
    setSpacePlacements(rail, [{project:p,space_id:"work",lamport:2,signer:"mac",op_id:"two"}]);
    assert.equal(set.merged(), view, "no hub refresh is required");
    assert.ok(getSpacePlacementVersion() > previousVersion);
    assert.equal(observed.projects.find((project) => project.id === "w10").space_id, "work");
    const version = getSpacePlacementVersion();
    setSpacePlacements(rail, [{project:p,space_id:"work",lamport:2,signer:"mac",op_id:"two"}]);
    assert.equal(getSpacePlacementVersion(), version, "the subsequent identical notification does not undo or invalidate the move");
  } finally { stop(); setSpacePlacements([]); }
});
