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
const { ACTIVE_KEY, LEGACY_KEY, RECORDS_KEY, deviceId, loadMachines, machineCredentials, machineStore, saveActive, tokenKey } = await import("../src/machines/storage.ts");

function memory(initial = {}) {
  const items = new Map(Object.entries(initial));
  return { items, get: async (k) => items.get(k), set: async (k, v) => void items.set(k, v), delete: async (k) => void items.delete(k) };
}
const legacy = JSON.stringify({
  environments: [
    { id: "mac", name: "Mac", url: "ws://100.64.0.1:4173/ws", token: "tok-mac", environmentId: "mac" },
    { id: "old", name: "Old", url: "wss://old.example/ws", token: "tok-old" },
    { id: "bad", name: "No token", url: "ws://x/ws" },
  ],
  activeId: "old",
});

test("saved computers migrate once: records without tokens, one token item per machine, the active choice, and the old item gone", async () => {
  const kv = memory({ [LEGACY_KEY]: legacy });
  const loaded = await loadMachines(kv);
  assert.deepEqual(loaded.records.map((r) => [r.machineId, r.name, r.member]), [["mac", "Mac", false], ["legacy:old", "Old", false]]);
  assert.equal(loaded.activeId, "legacy:old");
  assert.equal(kv.items.get(tokenKey("mac")), "tok-mac");
  assert.equal(kv.items.get(tokenKey("legacy:old")), "tok-old");
  assert.equal(kv.items.has(LEGACY_KEY), false, "tokens live only in their own items now");
  assert.equal(kv.items.get(ACTIVE_KEY), "legacy:old");
  assert.ok(!kv.items.get(RECORDS_KEY).includes("tok-"), "the records hold no token");
  // A second start reads what was written and migrates nothing.
  assert.deepEqual(await loadMachines(kv), loaded);
});

test("nothing saved, nothing to migrate; damaged data is ignored", async () => {
  assert.deepEqual(await loadMachines(memory()), { records: [], activeId: null });
  assert.deepEqual(await loadMachines(memory({ [RECORDS_KEY]: "{not json" })), { records: [], activeId: null });
  assert.deepEqual(await loadMachines(memory({ [LEGACY_KEY]: "{not json" })), { records: [], activeId: null });
  const kv = memory({ [RECORDS_KEY]: JSON.stringify({ version: 1, records: [{ machineId: "a", name: "A", routes: [], member: true }, { nope: 1 }] }), [ACTIVE_KEY]: "gone" });
  const loaded = await loadMachines(kv);
  assert.deepEqual(loaded.records.map((r) => r.machineId), ["a"]);
  assert.equal(loaded.activeId, null, "an active choice that is not a record is dropped");
});

test("a failed migration keeps the old item so nothing is lost", async () => {
  const kv = memory({ [LEGACY_KEY]: legacy });
  const set = kv.set;
  kv.set = async (key, value) => { if (key.startsWith("kybern.ink.token.")) throw new Error("keychain locked"); return set(key, value); };
  await assert.rejects(loadMachines(kv), /keychain locked/);
  assert.ok(kv.items.has(LEGACY_KEY));
});

test("the set's store and credentials read and write the same items", async () => {
  const kv = memory();
  const store = machineStore(kv);
  const records = [{ machineId: "mac", name: "Mac", routes: [], member: true, signingKey: "k" }];
  await store.save(records);
  assert.deepEqual(await store.load(), records);
  const creds = machineCredentials(kv);
  assert.equal(await creds.get("mac"), undefined);
  await creds.set("mac", "tok");
  assert.equal(await creds.get("mac"), "tok");
  await creds.delete("mac");
  assert.equal(await creds.get("mac"), undefined);
  await saveActive(kv, "mac");
  assert.equal(kv.items.get(ACTIVE_KEY), "mac");
  await saveActive(kv, null);
  assert.equal(kv.items.has(ACTIVE_KEY), false);
  assert.equal(tokenKey("a b/c:d"), "kybern.ink.token.a_b_c_d");
});

test("the device id is made once and survives", async () => {
  const kv = memory();
  const first = await deviceId(kv, () => "abc");
  assert.equal(first, "phone-abc");
  assert.equal(await deviceId(kv, () => "zzz"), "phone-abc");
  assert.match(first, /^[A-Za-z0-9._:-]{1,80}$/, "valid for network.client_grant");
});
