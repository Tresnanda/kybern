// #245 follow-up: with the paired computer away, the composer's agents and models and the space counts come from the
// network, not from the paired computer's (empty) lists.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { providerMachine, standInMachine, threadProviderMachine } from "../src/state/providerSource.ts";

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("a new chat reads the agents of the machine it will run on, also the paired one while it is away", () => {
  assert.equal(providerMachine({ remote: false, reachable: true, chosen: { machineId: "mac" } }), undefined);
  assert.deepEqual(providerMachine({ remote: true, reachable: true, chosen: { machineId: "pc" } }), { machineId: "pc", reachable: true });
  assert.deepEqual(providerMachine({ remote: false, reachable: false, chosen: { machineId: "mac" } }), { machineId: "mac", reachable: false });
  assert.equal(providerMachine({ remote: false, reachable: true }), undefined);
});

test("an open thread reads its own machine's agents", () => {
  assert.equal(threadProviderMachine({ machineId: "mac", remote: false, open: true }), undefined);
  assert.deepEqual(threadProviderMachine({ machineId: "pc", remote: true, open: true }), { machineId: "pc", reachable: true });
  assert.deepEqual(threadProviderMachine({ machineId: "mac", remote: false, open: false }), { machineId: "mac", reachable: false });
  assert.equal(threadProviderMachine({ remote: false, open: false }), undefined);
});

test("an away machine with no known list borrows a live member's, never its own or an offline one's", () => {
  const machines = [
    { machineId: "mac", status: "offline" },
    { machineId: "vps", status: "offline" },
    { machineId: "pc", status: "relaying" },
  ];
  assert.equal(standInMachine(machines, "mac", false), "pc");
  assert.equal(standInMachine(machines, "mac", true), undefined);
  assert.equal(standInMachine([{ machineId: "mac", status: "online" }], "mac", false), undefined);
});

test("pickers and space counts never read the paired computer's lists alone", () => {
  assert.doesNotMatch(source("src/features/ComposerControls.tsx"), /app\.providers/);
  assert.doesNotMatch(source("src/features/Spaces.tsx"), /useProjects\(/);
  assert.doesNotMatch(source("src/features/ScopeBar.tsx"), /useProjects\(/);
  assert.doesNotMatch(source("src/features/Composer.tsx"), /useProjects\(/);
});
