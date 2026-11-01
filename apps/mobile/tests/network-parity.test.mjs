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
const { NETWORK_PARITY_MIN_VERSION, gateDisabled, parityFooter, parityOn, versionOf } = await import("../src/machines/gate.ts");
const { cancelOutboxText, deviceSubtitle, groupDevices, outboxEntries, reachText, specRows, osLabel } = await import("../src/machines/settingsModel.ts");
const { FORK_COPY, noCheckoutText, offersMachineMoves, threadMachineLine, threadMachineModel } = await import("../src/state/threadMachineModel.ts");

// ---- the gate ----

test("the gate opens at 0.21.0 and above, dev builds and prereleases included", () => {
  assert.equal(NETWORK_PARITY_MIN_VERSION, "0.21.0");
  assert.equal(parityOn("0.21.0", false), true);
  assert.equal(parityOn("0.21.0-dev.3", false), true);
  assert.equal(parityOn("1.0.0", false), true);
  assert.equal(parityOn("0.20.6", false), false);
  assert.equal(parityOn("0.9.9", false), false);
  assert.equal(parityOn(undefined, false), false);
  assert.equal(parityOn(null, false), false);
});

test("the gate reads a version, a daemon info or a connection", () => {
  assert.equal(versionOf({ info: { version: "0.21.1" } }), "0.21.1");
  assert.equal(versionOf({ version: "0.20.0" }), "0.20.0");
  assert.equal(parityOn({ info: { version: "0.21.1" } }, false), true);
  assert.equal(parityOn({ info: { version: "0.20.1" } }, false), false);
  assert.equal(parityOn({ info: null }, false), false);
});

test("the dev override is read in development builds only", () => {
  const before = process.env.EXPO_PUBLIC_KYBERN_PARITY_GATE;
  process.env.EXPO_PUBLIC_KYBERN_PARITY_GATE = "off";
  try {
    // No __DEV__ here (a shipped build): the variable is ignored.
    assert.equal(gateDisabled(), false);
    assert.equal(parityOn("0.20.0"), false);
    globalThis.__DEV__ = true;
    assert.equal(gateDisabled(), true);
    assert.equal(parityOn("0.20.0"), true);
    process.env.EXPO_PUBLIC_KYBERN_PARITY_GATE = "on";
    assert.equal(gateDisabled(), false);
  } finally {
    delete globalThis.__DEV__;
    if (before === undefined) delete process.env.EXPO_PUBLIC_KYBERN_PARITY_GATE;
    else process.env.EXPO_PUBLIC_KYBERN_PARITY_GATE = before;
  }
});

test("the footer names the first member that is too old, or nothing", () => {
  assert.equal(parityFooter(["satyamas", "instabox"]), "Update Kybern on satyamas to 0.21 to manage more of your network here.");
  assert.equal(parityFooter([]), null);
});

// ---- the outbox ----

const item = (id, state, extra = {}) => ({ id, operation_id: id, target: "sat", kind: "fork", payload: null, state, attempts: 0, created_at: "2026-11-01T10:00:00Z", expires_at: "2026-11-02T10:00:00Z", updated_at: "2026-11-01T10:00:00Z", ...extra });
const names = new Map([["sat", "satyamas"], ["mac", "Mac Studio"]]);

test("the outbox merges every machine's items, newest first, once each, without history", () => {
  const rows = outboxEntries(
    [
      { holder: "mac", items: [item("a", "queued"), item("b", "delivered"), item("c", "failed", { kind: "thread_create", last_error: "No agent is signed in", created_at: "2026-11-01T12:00:00Z" })] },
      { holder: "sat", items: [item("a", "queued"), item("d", "cancelled"), item("e", "sending", { kind: "move", created_at: "2026-11-01T11:00:00Z" })] },
    ],
    names,
  );
  assert.deepEqual(rows.map((row) => row.id), ["c", "e", "a"]);
  assert.equal(rows[0].title, "New thread");
  assert.equal(rows[0].detail, "Failed: No agent is signed in");
  assert.equal(rows[0].holder, "mac");
  assert.deepEqual([rows[0].canRetry, rows[0].canCancel], [true, true]);
  assert.equal(rows[1].title, "Move of a thread");
  assert.deepEqual([rows[1].canRetry, rows[1].canCancel], [false, false]);
  assert.equal(rows[2].detail, "Waiting for satyamas");
  assert.equal(rows[2].title, "Fork of a thread");
});

test("a failure without a reason still says which machine", () => {
  const [row] = outboxEntries([{ holder: "mac", items: [item("x", "failed")] }], names);
  assert.equal(row.detail, "Failed: satyamas did not answer");
});

test("cancelling asks with the kind and the machine", () => {
  assert.deepEqual(cancelOutboxText({ title: "Fork of a thread", targetName: "satyamas" }), { title: "Cancel this fork of a thread?", message: "It will not be sent to satyamas." });
  assert.equal(cancelOutboxText({ title: "New thread", targetName: "x" }).title, "Cancel this new thread?");
});

// ---- paired devices ----

const token = (id, label, last, extra = {}) => ({ id, label, scopes: [], created_at: "2026-10-01T00:00:00Z", last_used_at: last, revoked: false, ...extra });

test("paired devices are grouped by device across machines and say where they reach", () => {
  const groups = groupDevices([
    { machineId: "mac", machineName: "Mac Studio", token: token("1", "iPad", "2026-10-30T00:00:00Z") },
    { machineId: "sat", machineName: "satyamas", token: token("2", "iPad", "2026-11-01T00:00:00Z") },
    { machineId: "mac", machineName: "Mac Studio", token: token("3", "Phone", null) },
    { machineId: "mac", machineName: "Mac Studio", token: token("4", "Old laptop", "2026-09-01T00:00:00Z", { revoked: true }) },
  ]);
  assert.deepEqual(groups.map((group) => group.label), ["iPad", "Phone"]);
  assert.deepEqual(groups[0].machines, ["Mac Studio", "satyamas"]);
  assert.equal(groups[0].tokens.length, 2);
  assert.equal(groups[0].lastUsedAt, "2026-11-01T00:00:00Z");
  assert.match(deviceSubtitle(groups[0]), /^On Mac Studio and satyamas · Last used /);
  assert.equal(deviceSubtitle(groups[1]), "On Mac Studio · Not used yet");
});

test("the reach sentence reads naturally for one, two and three machines", () => {
  assert.equal(reachText(["A"]), "On A");
  assert.equal(reachText(["A", "B"]), "On A and B");
  assert.equal(reachText(["A", "B", "C"]), "On A, B and C");
});

// ---- a machine's page ----

test("specs show only what the machine answered", () => {
  assert.deepEqual(specRows("darwin", { cpu: "Apple M1", cores: "8 cores", memory: "16 GB", gpus: [] }), [
    { label: "System", value: "macOS" },
    { label: "Processor", value: "Apple M1 · 8 cores" },
    { label: "Memory", value: "16 GB" },
  ]);
  assert.deepEqual(specRows(undefined, { cpu: null, cores: null, memory: null, gpus: [] }), []);
  assert.deepEqual(specRows("linux", { cpu: null, cores: "4 cores", memory: null, gpus: ["RTX 3060", "Radeon"] }).map((row) => row.value), ["Linux", "4 cores", "RTX 3060, Radeon"]);
  assert.equal(osLabel("BeOS"), "BeOS");
});

// ---- fork and continue targets ----

const proj = (id, extra = {}) => ({ id, name: "kybern", path: `/w/${id}`, kind: "repo", ...extra });
const instance = (machineId, id) => ({ machineId, project: proj(id) });
const logical = (instances) => ({ key: "root:abc", name: "kybern", spaceId: null, instances, primary: instances[0], colorSeed: "abc" });
const machine = (machineId, name, status = "online") => ({ machineId, name, status });

test("targets: machines with the project are choices, the rest say no checkout, offline ones wait", () => {
  const model = threadMachineModel({
    machines: [machine("mac", "Mac Studio"), machine("sat", "satyamas"), machine("kdi", "os-kdi", "offline"), machine("vps", "vps")],
    projects: [logical([instance("mac", "p-mac"), instance("sat", "p-sat"), instance("kdi", "p-kdi")])],
    threadMachine: "mac",
    projectId: "p-mac",
    gate: () => true,
  });
  assert.ok(model);
  assert.deepEqual(model.targets.map((t) => [t.machineName, t.missing, t.projectId, t.online]), [
    ["satyamas", false, "p-sat", true],
    ["os-kdi", false, "p-kdi", false],
    ["vps", true, "", true],
  ]);
  assert.equal(model.targets[0].detail, "Online");
  assert.match(model.targets[1].detail, /Offline/);
  assert.equal(model.targets[2].detail, "No checkout on vps");
  assert.equal(noCheckoutText("vps"), "No checkout on vps");
  assert.deepEqual(model.provisionFrom, { machineId: "mac", projectId: "p-mac" });
  assert.equal(offersMachineMoves(model, 4), true);
});

test("targets: the gate hides a machine that is too old and a paused one is left out", () => {
  const model = threadMachineModel({
    machines: [machine("mac", "Mac Studio"), machine("sat", "satyamas"), machine("old", "old"), machine("off", "paused", "paused")],
    projects: [logical([instance("mac", "p-mac"), instance("sat", "p-sat"), instance("old", "p-old")])],
    threadMachine: "mac",
    projectId: "p-mac",
    gate: (id) => id !== "old",
  });
  assert.deepEqual(model.targets.map((t) => t.machineId), ["sat"]);
});

test("targets: a free chat has no model, and a lone machine offers nothing", () => {
  const base = { machines: [machine("mac", "Mac")], projects: [], threadMachine: "mac", gate: () => true };
  assert.equal(threadMachineModel({ ...base, projectId: undefined }), null);
  assert.equal(threadMachineModel({ ...base, projectId: "p" }), null);
  assert.equal(offersMachineMoves(null, 2), false);
  assert.equal(offersMachineMoves({ targets: [] }, 2), false);
  assert.equal(offersMachineMoves({ targets: [{}] }, 1), false);
});

test("the sender of a project is another online machine when the thread's own is the only copy offline", () => {
  const model = threadMachineModel({
    machines: [machine("mac", "Mac"), machine("sat", "satyamas"), machine("vps", "vps")],
    projects: [logical([instance("mac", "p-mac"), instance("sat", "p-sat")])],
    threadMachine: "sat",
    projectId: "p-sat",
    gate: () => true,
  });
  assert.equal(model.provisionFrom.machineId, "sat");
  assert.deepEqual(model.targets.map((t) => [t.machineId, t.missing]), [["mac", false], ["vps", true]]);
});

test("the header says where the thread runs only with two machines, and flags an away one", () => {
  assert.equal(threadMachineLine(1, { name: "Mac", status: "online" }), "");
  assert.equal(threadMachineLine(2, undefined), "");
  assert.equal(threadMachineLine(2, { name: "satyamas", status: "online" }), "on satyamas");
  assert.equal(threadMachineLine(3, { name: "satyamas", status: "relaying" }), "on satyamas");
  assert.equal(threadMachineLine(2, { name: "satyamas", status: "offline" }), "on satyamas · offline");
});

test("the sheet keeps the spec's words", () => {
  assert.equal(FORK_COPY.forkAction, "Fork thread");
  assert.equal(FORK_COPY.moveAction, "Continue there");
});
