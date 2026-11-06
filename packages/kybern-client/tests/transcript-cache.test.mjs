import test from "node:test";
import assert from "node:assert/strict";
import { TranscriptCache, memoryTranscriptCacheStore, sqliteTranscriptCacheStore } from "../src/transcriptCache.ts";

function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map();
  return {
    now: () => now,
    timers: {
      setTimeout(fn, ms) {
        const id = next++;
        pending.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimeout(id) {
        pending.delete(id);
      },
    },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > now) continue;
        pending.delete(id);
        timer.fn();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

const page = (n, size = 10) => ({ thread: { id: `t${n}` }, transcript: ["x".repeat(size)] });
const ids = (store) => [...store.rows.values()].map((row) => row.threadId).sort();

test("a scheduled save is written 500 ms after the first change, then at most every 10 s", async () => {
  const clock = fakeTimers();
  const store = memoryTranscriptCacheStore();
  const cache = new TranscriptCache(store, { schema: 1, now: clock.now, timers: clock.timers });
  let seq = 5;
  cache.schedule("mac", "t1", () => ({ lastSeq: seq, data: page(1) }));
  await clock.advance(499);
  assert.equal(store.rows.size, 0);
  await clock.advance(1);
  await cache.flush();
  assert.equal(store.rows.size, 1);
  assert.equal([...store.rows.values()][0].lastSeq, 5);

  seq = 9;
  cache.schedule("mac", "t1", () => ({ lastSeq: seq, data: page(1) }));
  await clock.advance(5_000);
  assert.equal([...store.rows.values()][0].lastSeq, 5, "no second write inside 10 s");
  await clock.advance(5_000);
  await cache.flush();
  assert.equal([...store.rows.values()][0].lastSeq, 9);
});

test("the snapshot and cursor are read together at write time", async () => {
  const clock = fakeTimers();
  const store = memoryTranscriptCacheStore();
  const cache = new TranscriptCache(store, { schema: 1, now: clock.now, timers: clock.timers });
  const state = { seq: 1, data: page(1) };
  cache.schedule("mac", "t1", () => ({ lastSeq: state.seq, data: state.data }));
  state.seq = 2;
  state.data = page(2);
  await cache.flush();
  assert.deepEqual(await cache.load("mac", "t1"), { lastSeq: 2, data: page(2) });
});

test("a record of another schema or an unreadable one is deleted and missed", async () => {
  const store = memoryTranscriptCacheStore();
  store.write({ machineId: "mac", threadId: "old", schema: 1, lastSeq: 3, bytes: 2, usedAt: 0, body: "{}" });
  store.write({ machineId: "mac", threadId: "bad", schema: 2, lastSeq: 3, bytes: 5, usedAt: 0, body: "{oops" });
  store.write({ machineId: "mac", threadId: "wrong", schema: 2, lastSeq: 3, bytes: 2, usedAt: 0, body: "[]" });
  const cache = new TranscriptCache(store, {
    schema: 2,
    validate: (data) => typeof data === "object" && data !== null && !Array.isArray(data),
  });
  assert.equal(await cache.load("mac", "old"), undefined);
  assert.equal(await cache.load("mac", "bad"), undefined);
  assert.equal(await cache.load("mac", "wrong"), undefined);
  assert.equal(store.rows.size, 0);
});

test("the least recently used records go past the entry or byte bound", async () => {
  const clock = fakeTimers();
  const store = memoryTranscriptCacheStore();
  const cache = new TranscriptCache(store, {
    schema: 1,
    now: clock.now,
    timers: clock.timers,
    limits: { maxEntries: 3, maxBytes: 200 },
  });
  for (const n of [1, 2, 3]) {
    cache.schedule("mac", `t${n}`, () => ({ lastSeq: n, data: page(n) }));
    await clock.advance(1);
    await cache.flush();
  }
  await clock.advance(1);
  assert.ok(await cache.load("mac", "t1"), "reading t1 makes it recent");
  await clock.advance(1);
  cache.schedule("mac", "t4", () => ({ lastSeq: 4, data: page(4) }));
  await cache.flush();
  assert.deepEqual(ids(store), ["t1", "t3", "t4"]);

  await clock.advance(1);
  cache.schedule("mac", "big", () => ({ lastSeq: 1, data: page(9, 150) }));
  await cache.flush();
  const { bytes, entries } = await cache.stats();
  assert.ok(bytes <= 200, `bytes ${bytes}`);
  assert.ok(entries <= 3);
  assert.ok(store.rows.has("mac\u0000big"), "the newest record stays");

  cache.schedule("mac", "huge", () => ({ lastSeq: 1, data: page(9, 500) }));
  await cache.flush();
  assert.equal(store.rows.has("mac\u0000huge"), false, "a record above the whole budget is never kept");
});

test("a default cache holds 64 threads", async () => {
  const store = memoryTranscriptCacheStore();
  let now = 0;
  const cache = new TranscriptCache(store, { schema: 1, now: () => ++now });
  for (let n = 0; n < 70; n++) {
    cache.schedule("mac", `t${n}`, () => ({ lastSeq: n, data: page(n) }));
    await cache.flush();
  }
  assert.equal(store.rows.size, 64);
  assert.equal(store.rows.has("mac\u0000t5"), false);
  assert.equal(store.rows.has("mac\u0000t6"), true);
});

test("removing a machine or unpairing wipes its records and pending saves", async () => {
  const clock = fakeTimers();
  const store = memoryTranscriptCacheStore();
  const cache = new TranscriptCache(store, { schema: 1, now: clock.now, timers: clock.timers });
  cache.schedule("mac", "t1", () => ({ lastSeq: 1, data: page(1) }));
  cache.schedule("pc", "t2", () => ({ lastSeq: 1, data: page(2) }));
  await cache.flush();
  cache.schedule("mac", "t3", () => ({ lastSeq: 1, data: page(3) }));
  await cache.wipeMachine("mac");
  await clock.advance(1000);
  await cache.flush();
  assert.deepEqual(ids(store), ["t2"]);
  await cache.clear();
  assert.equal(store.rows.size, 0);
  assert.deepEqual(await cache.stats(), { entries: 0, bytes: 0 });
});

test("storage failures never throw into the caller", async () => {
  const errors = [];
  const store = memoryTranscriptCacheStore();
  store.read = () => {
    throw new Error("disk gone");
  };
  const cache = new TranscriptCache(store, { schema: 1, onError: (e) => errors.push(e.message) });
  assert.equal(await cache.load("mac", "t1"), undefined);
  assert.deepEqual(errors, ["disk gone"]);
});

test("the SQLite store maps rows through a minimal SQL surface", async () => {
  const statements = [];
  const table = new Map();
  const db = {
    run(sql, params) {
      statements.push(sql.split(" ")[0]);
      if (sql.startsWith("INSERT")) table.set(`${params[0]}/${params[1]}`, params);
      if (sql.startsWith("DELETE FROM transcript_cache WHERE machine_id = ? AND")) table.delete(`${params[0]}/${params[1]}`);
    },
    get(_sql, params) {
      const row = table.get(`${params[0]}/${params[1]}`);
      return (
        row && { machine_id: row[0], thread_id: row[1], schema: row[2], last_seq: row[3], bytes: row[4], used_at: row[5], body: row[6] }
      );
    },
    all() {
      return [...table.values()].map((row) => ({ machine_id: row[0], thread_id: row[1], bytes: row[4], used_at: row[5] }));
    },
  };
  const store = sqliteTranscriptCacheStore(db);
  await store.ensure();
  const cache = new TranscriptCache(store, { schema: 1 });
  cache.schedule("mac", "t1", () => ({ lastSeq: 7, data: page(1) }));
  await cache.flush();
  assert.deepEqual(await cache.load("mac", "t1"), { lastSeq: 7, data: page(1) });
  assert.equal(statements[0], "CREATE");
});
