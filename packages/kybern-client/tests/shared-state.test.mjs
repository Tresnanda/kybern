import assert from "node:assert/strict";
import test from "node:test";
import {
  federationFooter,
  footerOf,
  groupByMachine,
  isMixed,
  isWritableHere,
  machineOfItem,
  machineValues,
  mixedFields,
  pendingMachineNames,
  silentDetail,
  silentReason,
  useOnAllMachines,
  valueGroups,
} from "../src/sharedState.ts";

const machines = [
  { id: "a", name: "mac", is_self: true, state: "reported" },
  { id: "b", name: "satyamas", is_self: false, state: "reported" },
  { id: "c", name: "vps", is_self: false, state: "offline" },
];
const field = (path, values, mixed, pending = []) => ({
  path,
  values: machines.map((machine, index) => (values[index] === undefined ? { machine_id: machine.id } : { machine_id: machine.id, value: values[index] })),
  mixed,
  pending,
});
const view = {
  machines,
  fields: [
    field("generate_titles", [true, false, undefined], true, ["c"]),
    field("notifications", [true, true, undefined], false),
    field("title_provider", [null, null, undefined], false),
  ],
};

test("a field is Mixed when the machines that answered disagree, and an offline machine never makes it so", () => {
  assert.deepEqual(mixedFields(view).map((f) => f.path), ["generate_titles"]);
  assert.equal(isMixed(view, "generate_titles"), true);
  assert.equal(isMixed(view, "notifications"), false);
  assert.equal(isMixed(view, "nope"), false);
});

test("each machine's value is joined with the machine; a silent one is unknown, an unset optional field is null", () => {
  const values = machineValues(view, "generate_titles");
  assert.deepEqual(values.map((v) => [v.machine.name, v.known, v.value, v.pending]), [
    ["mac", true, true, false],
    ["satyamas", true, false, false],
    ["vps", false, undefined, true],
  ]);
  const optional = machineValues(view, "title_provider");
  assert.deepEqual(optional.map((v) => [v.known, v.value]), [[true, null], [true, null], [false, undefined]]);
  assert.deepEqual(machineValues(view, "nope"), []);
  assert.equal(silentReason(machines[0]), null);
  assert.match(silentReason(machines[2]), /vps is offline/);
  assert.match(silentReason({ ...machines[1], state: "unsupported" }), /newer Kybern/);
});

test("the popover groups machines by value, most common first, and offers one share per value", () => {
  const three = {
    machines: [...machines.slice(0, 2), { id: "d", name: "pc", is_self: false, state: "reported" }],
    fields: [{ path: "default_provider", mixed: true, pending: [], values: [{ machine_id: "a", value: "codex" }, { machine_id: "b", value: "claude-code" }, { machine_id: "d", value: "claude-code" }] }],
  };
  const groups = valueGroups(three, "default_provider");
  assert.deepEqual(groups.map((g) => [g.value, g.machines.map((m) => m.name)]), [["claude-code", ["satyamas", "pc"]], ["codex", ["mac"]]]);
  assert.deepEqual(useOnAllMachines("default_provider", "codex"), { fields: { default_provider: "codex" } });
  assert.deepEqual(valueGroups(view, "generate_titles").map((g) => g.value), [true, false], "a tie keeps this machine's value first");
  assert.deepEqual(pendingMachineNames(view, "generate_titles"), ["vps"]);
  assert.deepEqual(pendingMachineNames(view, "notifications"), []);
});

const skipped = (name, reason) => ({ machine_id: `id-${name}`, machine_name: name, reason });

test("the footer names the machines a merged read left out, the same words as the daemon", () => {
  assert.equal(federationFooter({ skipped: [] }, "notes"), null);
  assert.equal(federationFooter(null, "notes"), null);
  assert.equal(federationFooter({ skipped: [skipped("satyamas", "offline")] }, "notes"), "satyamas offline; its notes are not included.");
  assert.equal(
    federationFooter({ skipped: [skipped("a", "offline"), skipped("b", "timed_out")] }, "tasks"),
    "a offline, b did not answer in time; their tasks are not included.",
  );
  assert.match(federationFooter({ skipped: [skipped("x", "refused")] }, "notes"), /x has sharing turned off/);
  assert.equal(footerOf({ sections: [], skipped: [], footer: "from the daemon" }, "notes"), "from the daemon");
  assert.equal(footerOf({ sections: [], skipped: [skipped("v", "paused")] }, "notes"), "v paused; its notes are not included.");
});

test("a merged list groups by the machine that holds each item, in section order, and only the owner writes", () => {
  const notes = [{ id: "n3" }, { id: "n1" }, { id: "n2" }];
  const federation = {
    sections: [
      { machine_id: "a", machine_name: "mac", is_self: true, ids: ["n1"] },
      { machine_id: "b", machine_name: "satyamas", is_self: false, ids: ["n2", "n3", "gone"] },
    ],
    skipped: [skipped("vps", "offline")],
  };
  const groups = groupByMachine(notes, federation, (note) => note.id);
  assert.deepEqual(groups.map((g) => [g.machineName, g.items.map((n) => n.id)]), [["mac", ["n1"]], ["satyamas", ["n2", "n3"]]]);
  assert.equal(groups[0].isSelf, true);
  assert.deepEqual(machineOfItem(federation, "n2"), { id: "b", name: "satyamas", isSelf: false });
  assert.equal(machineOfItem(federation, "zzz"), null);
  assert.equal(isWritableHere(federation, "n1"), true);
  assert.equal(isWritableHere(federation, "n2"), false, "another machine's note is read-only here");
  assert.equal(isWritableHere(null, "n2"), true, "an unmerged list is this machine's own");
  const plain = groupByMachine(notes, null, (note) => note.id);
  assert.equal(plain.length, 1);
  assert.equal(plain[0].items.length, 3);
});

// ---- which edits are shared ----

import { SHARED_SETTINGS, changedSharedFields, describeSharedValue, sharedValue, useOnAllLabel } from "../src/sharedState.ts";

const baseSettings = () => ({
  default_provider: "claude-code",
  default_permission_mode: "supervised",
  worktrees_default: true,
  generate_titles: true,
  providers: { codex: { env: {}, model: "gpt-x" }, "claude-code": { env: {} } },
  notifications: false,
  auto_update_harnesses: true,
  auto_update_daemon: false,
  background: { session_idle_minutes: 30 },
  access: { tailscale: false },
  orchestration: { max_active_children: 4, lead_max_children: 6, max_depth: 2 },
  tell_agents_about_kybern: true,
});

test("a shared edit is found by path; per-machine edits are not", () => {
  const before = baseSettings();
  const after = { ...before, notifications: true, background: { session_idle_minutes: 5 }, providers: { ...before.providers, codex: { env: { K: "v" }, model: "gpt-y" } } };
  assert.deepEqual(changedSharedFields(before, after), { notifications: true, "providers.codex.model": "gpt-y" });
  assert.deepEqual(changedSharedFields(before, { ...before, access: { tailscale: true } }), {}, "access stays on this machine");
  assert.deepEqual(changedSharedFields(before, { ...before, providers: { codex: { env: { A: "1" }, model: "gpt-x" } } }), {}, "provider env is per machine");
});

test("clearing an optional field is shared as null", () => {
  const before = { ...baseSettings(), title_provider: "codex" };
  assert.deepEqual(changedSharedFields(before, { ...before, title_provider: null }), { title_provider: null });
  assert.deepEqual(changedSharedFields(baseSettings(), { ...baseSettings(), title_provider: null }), {}, "unset and null are the same");
  assert.equal(sharedValue(baseSettings(), "providers.claude-code.model"), null);
  assert.ok(SHARED_SETTINGS.includes("orchestration") && !SHARED_SETTINGS.includes("access"));
});

test("values read in words in the popover", () => {
  assert.equal(describeSharedValue("notifications", true), "On");
  assert.equal(describeSharedValue("notifications", false), "Off");
  assert.equal(describeSharedValue("title_provider", null), "Not set");
  assert.equal(describeSharedValue("default_provider", "codex", { codex: "Codex" }), "Codex");
  assert.equal(describeSharedValue("ask_deadlines", { enabled: true, max_seconds: 600 }), "On, up to 10 min");
  assert.equal(describeSharedValue("orchestration", { max_active_children: 4, lead_max_children: 6, max_depth: 2 }), "4 agents per thread, 6 per Coordinator, depth 2");
  assert.equal(useOnAllLabel("notifications", true), "Turn on for all machines");
  assert.equal(useOnAllLabel("default_provider", "codex", { codex: "Codex" }), "Use Codex on all machines");
});

test("an offline machine is unknown even when its entry holds null, and the popover says it gets the value when it is back", () => {
  // An offline machine reported nothing: a `null` beside it is not an unset value.
  const offline = {
    machines,
    fields: [{ path: "title_provider", mixed: false, pending: ["c"], values: [{ machine_id: "a", value: null }, { machine_id: "b", value: null }, { machine_id: "c", value: null }] }],
  };
  assert.deepEqual(machineValues(offline, "title_provider").map((v) => [v.machine.name, v.known, v.pending]), [
    ["mac", true, false],
    ["satyamas", true, false],
    ["vps", false, true],
  ]);
  assert.deepEqual(valueGroups(offline, "title_provider").map((g) => g.machines.map((m) => m.name)), [["mac", "satyamas"]], "it holds no value to offer");
  assert.equal(silentDetail(machines[2]), "Offline \u00b7 gets this when it's back");
  assert.equal(silentDetail(machines[0]), null);
  assert.equal(silentDetail({ ...machines[1], state: "unsupported" }), "Needs a newer Kybern");
  assert.equal(silentDetail({ ...machines[1], state: "unreachable" }), "No answer");
});
