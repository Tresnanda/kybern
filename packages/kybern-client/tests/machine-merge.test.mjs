import test from "node:test";
import assert from "node:assert/strict";
import {
  machineGlyph,
  machineGlyphs,
  mergeProjects,
  mergeThreads,
  mergedThreadRows,
  scopedKey,
  showMachineGlyph,
  threadParentKey,
} from "../src/machineMerge.ts";

const project = (id, name, repo, extra = {}) => ({
  id,
  name,
  path: `/work/${name}`,
  is_git: true,
  brief_in_all_threads: false,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  repo,
  ...extra,
});
const thread = (id, project_id, updated_at, extra = {}) => ({
  id,
  project_id,
  title: id,
  updated_at,
  created_at: updated_at,
  ...extra,
});
const maps = (obj) => new Map(Object.entries(obj));

test("projects merge by root commit across machines", () => {
  const merged = mergeProjects(
    maps({
      mac: [project("p1", "kybern", { root_commit: "r1", remote: "github.com/me/kybern" })],
      pc: [project("p9", "kybern-win", { root_commit: "r1", remote: "github.com/me/kybern" })],
    }),
    { machineOrder: ["mac", "pc"] },
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].key, "root:r1");
  assert.deepEqual(merged[0].instances.map((i) => [i.machineId, i.project.id]), [["mac", "p1"], ["pc", "p9"]]);
  assert.equal(merged[0].colorSeed, "root:r1");
});

test("two clones with the same root commit but different remotes still merge", () => {
  const merged = mergeProjects(
    maps({
      mac: [project("a", "fork", { root_commit: "r1", remote: "github.com/me/fork" })],
      pc: [project("b", "upstream", { root_commit: "r1", remote: "github.com/org/upstream" })],
    }),
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].key, "root:r1");
});

test("projects without a root commit merge by remote", () => {
  const merged = mergeProjects(
    maps({
      mac: [project("a", "x", { remote: "github.com/me/x" })],
      vps: [project("b", "x", { remote: "github.com/me/x" })],
    }),
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].key, "remote:github.com/me/x");
});

test("a project with no identity stays on its own machine, even when ids and names match", () => {
  const merged = mergeProjects(
    maps({
      mac: [project("same", "scratch", null), project("m2", "other", undefined)],
      pc: [project("same", "scratch", { root_commit: null, remote: null })],
    }),
  );
  assert.equal(merged.length, 3);
  assert.deepEqual(merged.map((p) => p.key), ["local:mac:same", "local:mac:m2", "local:pc:same"]);
});

test("a remote-only checkout joins the one root-commit group with that remote", () => {
  const merged = mergeProjects(
    maps({
      mac: [project("a", "x", { root_commit: "r1", remote: "github.com/me/x" })],
      pc: [project("b", "x", { remote: "github.com/me/x" })],
    }),
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].key, "root:r1");
  // Same answer whichever machine lists first.
  const flipped = mergeProjects(
    maps({
      pc: [project("b", "x", { remote: "github.com/me/x" })],
      mac: [project("a", "x", { root_commit: "r1", remote: "github.com/me/x" })],
    }),
  );
  assert.equal(flipped.length, 1);
  assert.equal(flipped[0].key, "root:r1");
});

test("a remote shared by two different root commits stays ambiguous", () => {
  const merged = mergeProjects(
    maps({
      mac: [project("a", "x", { root_commit: "r1", remote: "github.com/me/x" })],
      pc: [project("b", "x", { root_commit: "r2", remote: "github.com/me/x" })],
      vps: [project("c", "x", { remote: "github.com/me/x" })],
    }),
  );
  assert.deepEqual(merged.map((p) => p.key).sort(), ["remote:github.com/me/x", "root:r1", "root:r2"]);
});

test("group projects merge only with a group of the same repositories; free chat never merges", () => {
  const group = (id, repos) => project(id, "mono", repos[0], { kind: "group", repos });
  const a = { root_commit: "r1" };
  const b = { root_commit: "r2" };
  const merged = mergeProjects(
    maps({
      mac: [group("g1", [a, b]), project("single", "a", a), project("00000000-0000-0000-0000-000000000001", "Chats", null)],
      pc: [group("g2", [b, a]), project("00000000-0000-0000-0000-000000000001", "Chats", null)],
    }),
  );
  const keys = merged.map((p) => p.key);
  assert.deepEqual(keys, [
    "group:root:r1+root:r2",
    "root:r1",
    "local:mac:00000000-0000-0000-0000-000000000001",
    "local:pc:00000000-0000-0000-0000-000000000001",
  ]);
  assert.equal(merged[0].instances.length, 2);
});

test("the name and space come from the machine the user is at, else the first instance", () => {
  const input = maps({
    mac: [project("a", "kybern (mac)", { root_commit: "r1" }, { space_id: "s-mac" })],
    pc: [project("b", "kybern (pc)", { root_commit: "r1" }, { space_id: "s-pc" })],
  });
  const atPc = mergeProjects(input, { localMachineId: "pc", machineOrder: ["mac", "pc"] })[0];
  assert.equal(atPc.name, "kybern (pc)");
  assert.equal(atPc.spaceId, "s-pc");
  assert.equal(atPc.primary.machineId, "pc");
  const elsewhere = mergeProjects(input, { localMachineId: "phone", machineOrder: ["mac", "pc"] })[0];
  assert.equal(elsewhere.name, "kybern (mac)");
});

test("project order and offline flags are stable, and unchanged projects keep their identity", () => {
  const mac = [project("a", "a", { root_commit: "r1" }), project("b", "b", { root_commit: "r2" })];
  const pc = [project("c", "c", { root_commit: "r3" }), project("a2", "a", { root_commit: "r1" })];
  const input = maps({ pc, mac });
  const first = mergeProjects(input, { machineOrder: ["mac", "pc"], offline: new Set(["pc"]) });
  assert.deepEqual(first.map((p) => p.key), ["root:r1", "root:r2", "root:r3"]);
  assert.deepEqual(first[0].instances.map((i) => i.offline), [false, true]);
  const again = mergeProjects(input, { machineOrder: ["mac", "pc"], offline: new Set(["pc"]), previous: first });
  assert.ok(again.every((p, i) => p === first[i]));
  const changed = mergeProjects(input, { machineOrder: ["mac", "pc"], previous: first });
  assert.notEqual(changed[0], first[0]);
  assert.equal(changed[1], first[1]);
});

test("threads from every machine sort by updated_at and keep their machine", () => {
  const projects = mergeProjects(
    maps({
      mac: [project("p1", "x", { root_commit: "r1" })],
      pc: [project("p1", "x", { root_commit: "r1" })],
    }),
  );
  const merged = mergeThreads(
    maps({
      mac: [thread("t1", "p1", "2026-10-28T09:00:00Z"), thread("t2", "p1", "2026-10-28T11:00:00Z")],
      // Ids are not unique across machines.
      pc: [thread("t1", "p1", "2026-10-28T10:00:00Z")],
    }),
    projects,
  );
  assert.deepEqual(merged.all.map((m) => [m.machineId, m.thread.id]), [["mac", "t2"], ["pc", "t1"], ["mac", "t1"]]);
  assert.equal(merged.byProject.get("root:r1").length, 3);
  assert.notEqual(merged.byKey.get(scopedKey("mac", "t1")), merged.byKey.get(scopedKey("pc", "t1")));
});

test("threads of an unknown project are listed under the machine's own key; a cap keeps the newest", () => {
  const many = Array.from({ length: 10 }, (_, i) => thread(`t${i}`, "gone", `2026-10-28T10:0${i}:00Z`));
  const merged = mergeThreads(maps({ mac: many }), [], { maxPerMachine: 4 });
  assert.equal(merged.all.length, 4);
  assert.equal(merged.all[0].thread.id, "t9");
  assert.equal(merged.all[0].projectKey, "local:mac:gone");
});

test("offline machines mark their threads and carry when they were last seen", () => {
  const merged = mergeThreads(maps({ mac: [thread("t", "p", "2026-10-28T10:00:00Z")], pc: [thread("u", "p", "2026-10-28T09:00:00Z")] }), [], {
    offline: new Set(["pc"]),
    lastSeenAt: new Map([["pc", 123]]),
  });
  const [mac, pc] = merged.all;
  assert.equal(mac.offline, false);
  assert.equal(mac.lastSeenAt, undefined);
  assert.equal(pc.offline, true);
  assert.equal(pc.lastSeenAt, 123);
});

test("unchanged threads keep their identity across merges", () => {
  const list = [thread("t1", "p", "2026-10-28T10:00:00Z")];
  const first = mergeThreads(maps({ mac: list }), []);
  const same = mergeThreads(maps({ mac: list }), [], { previous: first });
  assert.equal(same.all[0], first.all[0]);
  const next = mergeThreads(maps({ mac: [{ ...list[0] }] }), [], { previous: first });
  assert.notEqual(next.all[0], first.all[0]);
});

test("a thread started from a thread on another machine is listed under it", () => {
  const parentOnMac = thread("parent", "p", "2026-10-28T10:00:00Z");
  const childOnPc = thread("child", "p", "2026-10-28T11:00:00Z", { origin: { machine_id: "mac", thread_id: "parent" } });
  const sibling = thread("local-child", "p", "2026-10-28T09:00:00Z", { parent_thread_id: "child" });
  const merged = mergeThreads(maps({ mac: [parentOnMac], pc: [childOnPc, sibling] }), []);
  assert.equal(merged.byKey.get(scopedKey("pc", "child")).parentKey, scopedKey("mac", "parent"));
  assert.equal(merged.byKey.get(scopedKey("pc", "local-child")).parentKey, scopedKey("pc", "child"));
  const rows = mergedThreadRows(merged.all, {}, undefined, () => true);
  assert.deepEqual(rows.map((r) => [r.thread.thread.id, r.depth]), [["parent", 0], ["child", 1], ["local-child", 2]]);
});

test("a child whose parent is not visible is listed on its own", () => {
  const orphan = thread("child", "p", "2026-10-28T11:00:00Z", { origin: { machine_id: "mac", thread_id: "missing" } });
  const merged = mergeThreads(maps({ pc: [orphan] }), []);
  const rows = mergedThreadRows(merged.all, {});
  assert.deepEqual(rows.map((r) => [r.thread.thread.id, r.depth]), [["child", 0]]);
});

test("the same thread id on two machines never nests under the wrong parent", () => {
  const a = thread("x", "p", "2026-10-28T10:00:00Z");
  const child = thread("c", "p", "2026-10-28T11:00:00Z", { parent_thread_id: "x" });
  const merged = mergeThreads(maps({ mac: [a], pc: [thread("x", "p", "2026-10-28T09:00:00Z"), child] }), []);
  assert.equal(merged.byKey.get(scopedKey("pc", "c")).parentKey, scopedKey("pc", "x"));
  assert.equal(threadParentKey("pc", { id: "self", parent_thread_id: "self" }), undefined);
});

test("the glyph shows only with more than one machine and never on the machine the user is at", () => {
  assert.equal(showMachineGlyph({ machineCount: 1, machineId: "pc", localMachineId: "mac" }), false);
  assert.equal(showMachineGlyph({ machineCount: 2, machineId: "mac", localMachineId: "mac" }), false);
  assert.equal(showMachineGlyph({ machineCount: 2, machineId: "pc", localMachineId: "mac" }), true);
  assert.equal(showMachineGlyph({ machineCount: 3, machineId: "pc" }), true);
});

test("the glyph is the first letter of the name, with a hue from the id", () => {
  const a = machineGlyph({ machineId: "id-1", name: "satyamas" });
  assert.equal(a.letter, "S");
  assert.equal(machineGlyph({ machineId: "id-1", name: "other" }).hue, a.hue);
  assert.notEqual(machineGlyph({ machineId: "id-2", name: "satyamas" }).hue, a.hue);
  assert.ok(a.hue >= 0 && a.hue < 360);
  assert.equal(machineGlyph({ machineId: "xyz", name: "  " }).letter, "X");
  assert.equal(machineGlyph({ machineId: "xyz", name: "école" }).letter, "É");
});

test("machines that start with the same letter get distinct letters, the same on every client", () => {
  const machines = [
    { machineId: "b-id", name: "srv1544252" },
    { machineId: "a-id", name: "satyamas" },
    { machineId: "c-id", name: "os-kdi" },
  ];
  const letters = (list) => Object.fromEntries([...machineGlyphs(list)].map(([id, glyph]) => [id, glyph.letter]));
  assert.deepEqual(letters(machines), { "a-id": "S", "b-id": "Sr", "c-id": "O" });
  assert.deepEqual(letters([...machines].reverse()), letters(machines));
  // The hue still comes from the id alone.
  assert.equal(machineGlyphs(machines).get("b-id").hue, machineGlyph(machines[0]).hue);
  // A name with no free single letter takes two; a lone machine is unchanged.
  assert.equal(machineGlyphs([{ machineId: "x", name: "ss" }, { machineId: "y", name: "ss" }]).get("y").letter, "Ss");
  assert.equal(machineGlyphs([{ machineId: "x", name: "satyamas" }]).get("x").letter, "S");
});

test("the next word gives the letter before a second letter does", () => {
  const letters = (list) => Object.fromEntries([...machineGlyphs(list)].map(([id, glyph]) => [id, glyph.letter]));
  assert.deepEqual(letters([{ machineId: "a", name: "Satya PC" }, { machineId: "b", name: "Studio Mac" }]), { a: "S", b: "M" });
  assert.deepEqual(letters([{ machineId: "a", name: "SatyaMas" }, { machineId: "b", name: "Sandbox" }]), { a: "S", b: "Sa" });
  assert.deepEqual(letters([{ machineId: "a", name: "VM-3-60-ubuntu" }, { machineId: "b", name: "vps-ubuntu" }]), { a: "V", b: "U" });
});

test("a letter never changes once assigned, whatever the machine is renamed to", () => {
  const mac = { machineId: "a", name: "SatyaMas" };
  const first = machineGlyphs([mac, { machineId: "b", name: "Sandbox" }]);
  assert.equal(first.get("a").letter, "S");
  assert.equal(first.get("b").letter, "Sa");
  assert.deepEqual([...first.fresh], [["a", "S"], ["b", "Sa"]]);
  const kept = new Map([...first].map(([id, glyph]) => [id, glyph.letter]));
  // Renamed, and listed in another order: the same letters, nothing new to save.
  const again = machineGlyphs([{ machineId: "b", name: "Sandbox" }, { machineId: "a", name: "Alpha" }], kept);
  assert.equal(again.get("a").letter, "S");
  assert.equal(again.get("b").letter, "Sa");
  assert.equal(again.fresh.size, 0);
  // A new machine takes the next free letter and does not move the others.
  const third = machineGlyphs([mac, { machineId: "b", name: "Sandbox" }, { machineId: "c", name: "Sunbeam" }], kept);
  assert.equal(third.get("c").letter, "Su");
  assert.equal(third.get("a").letter, "S");
});

test("checkouts that share any root commit are one project; a shallow clone joins by its remote", () => {
  const remote = "github.com/me/kybern";
  const merged = mergeProjects(
    maps({
      mac: [project("a", "kybern", { root_commit: "r1", root_commits: ["r1", "r7"], remote })],
      pc: [project("b", "kybern", { root_commit: "r7", root_commits: ["r7", "r9"], remote })],
      vps: [project("c", "kybern", { remote })],
      old: [project("d", "kybern", { root_commit: "r7" })],
    }),
  );
  assert.deepEqual(merged.map((p) => p.key), ["root:r1"]);
  assert.equal(merged[0].instances.length, 4);
});
