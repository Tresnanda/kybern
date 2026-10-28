import test from "node:test";
import assert from "node:assert/strict";
import { MachineCache } from "../src/machineCache.ts";
import { memoryCacheStorage } from "./machine-fakes.mjs";

const thread = (n, extra = {}) => ({
  id: `t${n}`,
  project_id: "p",
  title: `Thread ${n}`,
  updated_at: new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString(),
  ...extra,
});
const project = (n) => ({ id: `p${n}`, name: `Project ${n}` });

test("a machine keeps its newest 300 threads and nothing else", () => {
  const cache = new MachineCache();
  const threads = Array.from({ length: 450 }, (_, n) => thread(n));
  const snapshot = cache.put("mac", { projects: [project(1)], threads }, 1000);
  assert.equal(snapshot.threads.length, 300);
  assert.equal(snapshot.threads[0].id, "t449");
  assert.equal(snapshot.threads.at(-1).id, "t150");
  assert.equal(snapshot.savedAt, 1000);
});

test("projects, machines and bytes are bounded", () => {
  const cache = new MachineCache(undefined, { projectsPerMachine: 5, machines: 3, bytesPerMachine: 2000 });
  cache.put("a", { projects: Array.from({ length: 9 }, (_, n) => project(n)), threads: [] }, 1);
  assert.equal(cache.get("a").projects.length, 5);
  cache.put("b", { projects: [], threads: [] }, 2);
  cache.put("c", { projects: [], threads: [] }, 3);
  cache.put("d", { projects: [], threads: [] }, 4);
  assert.deepEqual(cache.machineIds().sort(), ["b", "c", "d"]);
  const fat = Array.from({ length: 100 }, (_, n) => thread(n, { title: "x".repeat(200) }));
  const snapshot = cache.put("fat", { projects: [], threads: fat }, 5);
  assert.ok(JSON.stringify({ projects: snapshot.projects, threads: snapshot.threads }).length <= 2000);
  assert.ok(snapshot.threads.length > 0);
  assert.equal(snapshot.threads[0].id, "t99", "the newest survive");
});

test("a fresh read replaces the machine's entry whole", () => {
  const cache = new MachineCache();
  cache.put("mac", { projects: [project(1), project(2)], threads: [thread(1), thread(2)] }, 1);
  const next = cache.put("mac", { projects: [project(3)], threads: [thread(3)] }, 2);
  assert.deepEqual(next.projects.map((p) => p.id), ["p3"]);
  assert.deepEqual(cache.get("mac").threads.map((t) => t.id), ["t3"]);
  assert.equal(cache.get("mac").savedAt, 2);
});

test("the cache survives a restart through the storage it was given", async () => {
  const storage = memoryCacheStorage();
  const first = new MachineCache(storage);
  first.put("mac", { projects: [project(1)], threads: [thread(1)] }, 42);
  first.put("pc", { projects: [], threads: [thread(2)] }, 43);
  await first.flush();
  assert.equal(storage.writes, 1, "puts in a row write once");
  const second = new MachineCache(storage);
  await second.load();
  assert.deepEqual(second.get("mac").threads.map((t) => t.id), ["t1"]);
  assert.equal(second.get("mac").savedAt, 42);
  assert.deepEqual(second.machineIds().sort(), ["mac", "pc"]);
  second.delete("pc");
  await second.flush();
  const third = new MachineCache(storage);
  await third.load();
  assert.deepEqual(third.machineIds(), ["mac"]);
});

test("a damaged, foreign or oversized file is ignored or trimmed, never thrown", async () => {
  for (const text of ["", "not json", "[]", JSON.stringify({ v: 99, machines: [] }), JSON.stringify({ v: 1, machines: "x" })]) {
    const cache = new MachineCache(memoryCacheStorage(text));
    await cache.load();
    assert.deepEqual(cache.machineIds(), []);
  }
  const big = {
    v: 1,
    machines: [
      { machineId: "mac", savedAt: 1, projects: [{ id: "p" }, 7, null], threads: Array.from({ length: 500 }, (_, n) => thread(n)) },
      { machineId: 5, savedAt: 1 },
    ],
  };
  const cache = new MachineCache(memoryCacheStorage(JSON.stringify(big)));
  await cache.load();
  assert.deepEqual(cache.machineIds(), ["mac"]);
  assert.equal(cache.get("mac").threads.length, 300);
  assert.equal(cache.get("mac").projects.length, 1);
  const failing = new MachineCache({ read: () => { throw new Error("disk"); }, write: () => {} });
  await failing.load();
  assert.deepEqual(failing.machineIds(), []);
});

test("a failing write never breaks the app", async () => {
  const cache = new MachineCache({ read: () => null, write: () => { throw new Error("full"); } });
  cache.put("mac", { projects: [], threads: [] }, 1);
  await cache.flush();
  assert.ok(cache.get("mac"));
});
