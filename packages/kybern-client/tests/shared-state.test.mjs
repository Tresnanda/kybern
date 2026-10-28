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
