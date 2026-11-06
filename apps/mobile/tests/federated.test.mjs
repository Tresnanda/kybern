// Notes and tasks through the network (#245): read through the network client (the computer the phone
// is at, else a live member) with `machine: "all"`, written on the machine that holds the item, kept
// from the offline copy while their machine is away, and read-only then.
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
const federated = await import("../src/state/federated.ts");
const notes = await import("../src/state/notes.ts");
const tasks = await import("../src/state/tasks.ts");
const { setListCacheStorage } = await import("../src/state/listCache.ts");

const note = (id, extra = {}) => ({ id, title: id, scope: "global", project_id: null, pinned: false, revision: 1, updated_at: "2026-11-01T00:00:00Z", created_at: "2026-11-01T00:00:00Z", preview: "", ...extra });
const task = (id, extra = {}) => ({ id, key: id.toUpperCase(), title: id, status: "todo", priority: 0, body: "", revision: 1, scope: "global", project_id: null, created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", ...extra });

/** A daemon of one machine: records its calls and answers from `handlers`. */
function fakeClient(name, handlers = {}) {
  const calls = [];
  return {
    name,
    calls,
    onNotification() { return () => {}; },
    async call(method, params) {
      calls.push([method, params]);
      const handler = handlers[method];
      if (handler) return handler(params);
      if (method.startsWith("notes.")) return note(params.id ?? "made");
      if (method.startsWith("tasks.items.")) return task(params.id ?? "made");
      return {};
    },
  };
}

function network({ macLive }) {
  const mac = fakeClient("mac", {
    "notes.list": () => ({ notes: [note("n-mac"), note("n-vps")], federation: { sections: [{ machine_id: "mac", machine_name: "Mac", is_self: true, ids: ["n-mac"] }, { machine_id: "vps", machine_name: "VPS", is_self: false, ids: ["n-vps"] }], skipped: [] } }),
    "tasks.items.list": () => ({ tasks: [task("t-mac"), task("t-vps")], federation: { sections: [{ machine_id: "mac", machine_name: "Mac", is_self: true, ids: ["t-mac"] }, { machine_id: "vps", machine_name: "VPS", is_self: false, ids: ["t-vps"] }], skipped: [] } }),
  });
  const vps = fakeClient("vps", {
    "notes.list": () => ({ notes: [note("n-vps")], federation: { sections: [{ machine_id: "vps", machine_name: "VPS", is_self: true, ids: ["n-vps"] }], skipped: [{ machine_id: "mac", machine_name: "Mac", reason: "offline" }] } }),
    "tasks.items.list": () => ({ tasks: [task("t-vps")], federation: { sections: [{ machine_id: "vps", machine_name: "VPS", is_self: true, ids: ["t-vps"] }], skipped: [{ machine_id: "mac", machine_name: "Mac", reason: "offline" }] } }),
  });
  const live = { mac: macLive, vps: true };
  const routing = {
    network: () => (live.mac ? { client: mac, machineId: "mac" } : { client: vps, machineId: "vps" }),
    machine: (id) => (live[id] ? { mac, vps }[id] : null),
    name: (id) => ({ mac: "Mac", vps: "VPS" })[id] ?? id,
    multiple: () => true,
  };
  federated.setNetworkRouting(routing);
  return { mac, vps, live };
}

test("notes: every machine's notes through the computer, each written where it lives", async () => {
  const { mac, vps } = network({ macLive: true });
  notes.resetNotes();
  notes.attachNotes(mac, () => true, "mac");
  await notes.loadNotes();
  assert.deepEqual(mac.calls[0], ["notes.list", { machine: "all" }]);
  assert.deepEqual(notes.getNotes().notes.map((n) => n.id).sort(), ["n-mac", "n-vps"]);
  await notes.pinNote("n-vps", true);
  await notes.pinNote("n-mac", true);
  assert.deepEqual(vps.calls.map(([m, p]) => [m, p.id]), [["notes.pin", "n-vps"]], "another machine's note is written on that machine");
  assert.ok(mac.calls.some(([m, p]) => m === "notes.pin" && p.id === "n-mac"));
  const made = await notes.createNote({ title: "New" });
  assert.equal(mac.calls.at(-1)[0], "notes.create", "a new note is made on the machine that answers");
  assert.equal(federated.ownerOf("notes", made.id), "mac");
  federated.setNetworkRouting(null);
});

test("notes: with the computer away a member answers, and the computer's notes stay, read-only", async () => {
  const world = network({ macLive: true });
  notes.resetNotes();
  notes.attachNotes(world.mac, () => true, "mac");
  await notes.loadNotes();
  // The computer goes away: the member answers for the network.
  world.live.mac = false;
  const macCalls = world.mac.calls.length;
  await notes.loadNotes();
  assert.deepEqual(world.vps.calls.find(([m]) => m === "notes.list"), ["notes.list", { machine: "all" }]);
  assert.deepEqual(notes.getNotes().notes.map((n) => n.id).sort(), ["n-mac", "n-vps"], "the away computer's note is kept from the last read");
  assert.equal(notes.noteWritable("n-mac"), false);
  assert.equal(notes.noteWritable("n-vps"), true);
  await assert.rejects(notes.pinNote("n-mac", true), /Mac is offline\. Its notes are read-only until it is back/);
  await notes.pinNote("n-vps", true);
  assert.ok(world.vps.calls.some(([m, p]) => m === "notes.pin" && p.id === "n-vps"));
  await notes.createNote({ title: "Made on the member" });
  assert.equal(world.vps.calls.at(-1)[0], "notes.create", "new notes go to the member that answers");
  assert.equal(world.mac.calls.length, macCalls, "nothing reached the away computer");
  federated.setNetworkRouting(null);
});

test("tasks: the offline copy keeps who holds each task, so an away machine's tasks stay read-only after a restart", async () => {
  let saved = null;
  setListCacheStorage({ read: () => saved, write: (text) => { saved = text; } });
  const world = network({ macLive: true });
  tasks.resetTasks();
  tasks.attachTasks(world.mac, () => true, "mac");
  await tasks.loadTasks();
  assert.deepEqual(world.mac.calls[0], ["tasks.items.list", { machine: "all" }]);
  await tasks.setTaskStatus("t-vps", "done");
  assert.ok(world.vps.calls.some(([m, p]) => m === "tasks.items.update" && p.id === "t-vps"));
  const { listCache } = await import("../src/state/listCache.ts");
  listCache().flush();
  assert.ok(saved?.includes("__owner"));
  // A cold start with the computer away: the copy shows, its tasks are read-only, the member's are not.
  setListCacheStorage({ read: () => saved, write: (text) => { saved = text; } });
  world.live.mac = false;
  tasks.resetTasks();
  tasks.attachTasks(world.mac, () => true, "mac");
  assert.equal(tasks.getTasks().loaded, true);
  assert.deepEqual(tasks.getTasks().tasks.map((t) => t.id).sort(), ["t-mac", "t-vps"]);
  assert.equal(tasks.taskWritable("t-mac"), false);
  assert.equal(tasks.taskWritable("t-vps"), true);
  await assert.rejects(tasks.setTaskStatus("t-mac", "done"), /Mac is offline\. Its tasks are read-only/);
  await tasks.loadTasks();
  assert.deepEqual(tasks.getTasks().tasks.map((t) => t.id).sort(), ["t-mac", "t-vps"]);
  federated.setNetworkRouting(null);
  tasks.resetTasks();
});

test("without the network routing (one computer, tests) the stores use their own client and list only it", async () => {
  federated.setNetworkRouting(null);
  const mac = fakeClient("mac", { "notes.list": () => ({ notes: [note("a")] }) });
  notes.resetNotes();
  notes.attachNotes(mac, () => true, "mac");
  await notes.loadNotes();
  assert.deepEqual(mac.calls[0], ["notes.list", {}]);
  await notes.pinNote("a", true);
  assert.equal(mac.calls.at(-1)[0], "notes.pin");
  notes.resetNotes();
});
