// Settings, Add project and Import sessions work on a picked machine, and keep working while the paired computer is
// away (#245): the pick while it answers, else the paired computer while it answers, else the nearest live machine.
import assert from "node:assert/strict";
import test from "node:test";
import { resolveChoice } from "../src/state/machineChoiceModel.ts";

const machines = [
  { machineId: "mac", name: "Mac", status: "offline" },
  { machineId: "vps", name: "VPS", status: "offline" },
  { machineId: "pc", name: "SatyaMas", status: "online" },
];

test("the paired computer while it answers, unless another machine is picked", () => {
  const up = machines.map((m) => (m.machineId === "mac" ? { ...m, status: "online" } : m));
  assert.deepEqual(resolveChoice({ picked: null, machines: up, primaryId: "mac", primaryOpen: true }), { machineId: "mac", name: "Mac", primary: true, live: true });
  assert.equal(resolveChoice({ picked: "pc", machines: up, primaryId: "mac", primaryOpen: true }).machineId, "pc");
});

test("with the paired computer away, a live machine stands in, and a pick of an away one is not kept", () => {
  assert.deepEqual(resolveChoice({ picked: null, machines, primaryId: "mac", primaryOpen: false }), { machineId: "pc", name: "SatyaMas", primary: false, live: true });
  assert.equal(resolveChoice({ picked: "vps", machines, primaryId: "mac", primaryOpen: false }).machineId, "pc");
});

test("the phone's own socket decides whether the paired computer answers", () => {
  const listedOnline = machines.map((m) => (m.machineId === "mac" ? { ...m, status: "online" } : m));
  assert.equal(resolveChoice({ picked: "mac", machines: listedOnline, primaryId: "mac", primaryOpen: false }).machineId, "pc");
});

test("nothing live leaves the paired computer, offline", () => {
  const down = machines.map((m) => ({ ...m, status: "offline" }));
  assert.deepEqual(resolveChoice({ picked: null, machines: down, primaryId: "mac", primaryOpen: false }), { machineId: "mac", name: "Mac", primary: true, live: false });
  assert.equal(resolveChoice({ picked: null, machines: [], primaryId: undefined, primaryOpen: false }), undefined);
});
