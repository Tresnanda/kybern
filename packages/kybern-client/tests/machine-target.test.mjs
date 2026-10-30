import test from "node:test";
import assert from "node:assert/strict";
import { defaultMachine, machineChoices, machineMemoryKey, queuedCreate, resolveMachine, showMachinePicker } from "../src/machineTarget.ts";

const machines = [
  { machineId: "mac", name: "Mac", status: "online", isLocal: true },
  { machineId: "sat", name: "satyamas", status: "online", isLocal: false },
  { machineId: "vps", name: "vps", status: "offline", isLocal: false },
];
const instance = (machineId, id, offline = false) => ({ machineId, project: { id }, offline });
const project = (...instances) => ({ key: "root:abc", instances });

test("rows: online and offline machines with the project can be chosen, the rest say why not", () => {
  const rows = machineChoices({ machines, project: project(instance("mac", "p1"), instance("vps", "p3", true)) });
  assert.deepEqual(rows.map((row) => [row.machineId, row.state, row.selectable]), [["mac", "online", true], ["sat", "no-checkout", false], ["vps", "offline", true]]);
  assert.equal(rows[1].detail, "No checkout · add to this machine…");
  assert.equal(rows[2].detail, "Offline · sends when it returns");
  assert.equal(rows[0].projectId, "p1");
  assert.equal(rows[2].projectId, "p3");
});

test("the machine you are at lists first, whatever the order of the network", () => {
  const rows = machineChoices({ machines: [machines[1], machines[0]], project: null });
  assert.deepEqual(rows.map((row) => row.machineId), ["mac", "sat"]);
});

test("a free chat counts every machine as having it", () => {
  const rows = machineChoices({ machines, project: null });
  assert.deepEqual(rows.map((row) => row.selectable), [true, true, true]);
  assert.equal(rows[0].projectId, undefined);
});

test("the chip offers setup with multiple machines and one checkout; free chat keeps its online rule", () => {
  const two = project(instance("mac", "p1"), instance("sat", "p2"));
  assert.equal(showMachinePicker(machineChoices({ machines, project: two }), two), true);
  const one = project(instance("mac", "p1"));
  assert.equal(showMachinePicker(machineChoices({ machines, project: one }), one), true);
  assert.equal(showMachinePicker(machineChoices({ machines, project: null }), null), true);
  assert.equal(showMachinePicker(machineChoices({ machines: [machines[0], machines[2]], project: null }), null), false);
  assert.equal(showMachinePicker(machineChoices({ machines: [machines[0]], project: null }), null), false);
});

test("default: the last machine used for the project, else the machine you are at", () => {
  const two = project(instance("mac", "p1"), instance("sat", "p2"));
  const choices = machineChoices({ machines, project: two });
  assert.equal(defaultMachine({ choices, lastUsed: "sat" }), "sat");
  assert.equal(defaultMachine({ choices }), "mac");
  // A remembered machine without the project, or no longer in the network, is skipped.
  assert.equal(defaultMachine({ choices, lastUsed: "vps" }), "mac");
  assert.equal(defaultMachine({ choices, lastUsed: "gone" }), "mac");
});

test("default: with no local checkout the first online machine, then any", () => {
  const away = project(instance("sat", "p2"), instance("vps", "p3", true));
  assert.equal(defaultMachine({ choices: machineChoices({ machines, project: away }) }), "sat");
  const offlineOnly = project(instance("vps", "p3", true));
  assert.equal(defaultMachine({ choices: machineChoices({ machines, project: offlineOnly }) }), "vps");
  assert.equal(defaultMachine({ choices: [] }), undefined);
});

test("an offline remembered machine is still the default: the send queues for it", () => {
  const both = project(instance("mac", "p1"), instance("vps", "p3", true));
  assert.equal(defaultMachine({ choices: machineChoices({ machines, project: both }), lastUsed: "vps" }), "vps");
});

test("resolve: the draft's pick wins while it can be chosen", () => {
  const two = project(instance("mac", "p1"), instance("sat", "p2"));
  const choices = machineChoices({ machines, project: two });
  assert.equal(resolveMachine(choices, "sat", "mac")?.machineId, "sat");
  assert.equal(resolveMachine(choices, "vps", "sat")?.machineId, "sat");
  assert.equal(resolveMachine(choices, null, null)?.machineId, "mac");
  assert.equal(resolveMachine([], "sat", "mac"), undefined);
});

test("memory key: the logical project, or the free chat's", () => {
  assert.equal(machineMemoryKey({ key: "root:abc" }), "root:abc");
  assert.equal(machineMemoryKey(null), "free");
});

test("a queued create is a thread_create with the composer's parameters", () => {
  const op = queuedCreate({ thread_id: "t1", provider: { kind: "codex", instance: "default" }, project_id: "p2" }, "op1");
  assert.equal(op.kind, "thread_create");
  assert.equal(op.operation_id, "op1");
  assert.equal(op.payload.thread_id, "t1");
  assert.equal("operation_id" in queuedCreate({ thread_id: "t1", provider: { kind: "codex", instance: "default" } }), false);
});


test("a partial group offers setup, cannot become the send target, and leaves the source selected", () => {
  const full = { kind: "group", repos: [{ root_commit: "web" }, { root_commit: "api" }], members: [{ path: "web", status: "ok" }, { path: "api", status: "ok" }] };
  const source = { ...instance("mac", "p1"), project: { ...full, id: "p1" } };
  for (const members of [undefined, [], [{ path: "web", status: "ok" }], [{ path: "web", status: "ok" }, { path: "api", status: "missing" }]]) {
    const partial = { ...instance("sat", "p2"), project: { ...full, id: "p2", members } };
    const choices = machineChoices({ machines, project: project(source, partial) });
    assert.equal(choices[1].state, "no-checkout");
    assert.equal(resolveMachine(choices, "sat", null).machineId, "mac");
    assert.equal(showMachinePicker(choices, {}), true);
  }
  const choices = machineChoices({ machines, project: project(source, { ...instance("sat", "p2"), project: { ...full, id: "p2" } }) });
  assert.equal(resolveMachine(choices, "sat", null).projectId, "p2");
  assert.equal(showMachinePicker(machineChoices({ machines: [machines[0]], project: project(source) }), {}), false);
});


test("a local group remains usable before git identity refresh", () => {
  const local = { ...instance("mac", "p1"), project: { id: "p1", kind: "group", members: [{ path: "web", status: "ok" }] } };
  const choices = machineChoices({ machines, project: project(local) });
  assert.equal(choices[0].selectable, true);
  assert.equal(showMachinePicker(choices, {}), true);
  assert.equal(choices[1].state, "no-checkout");
});
