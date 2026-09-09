import assert from "node:assert/strict";
import test from "node:test";
import { ThreadCache } from "../src/state/threadCache.ts";
import {
  applyEvent,
  retainHistoryIdentities,
  seedFromGet,
} from "../src/state/transcript.ts";

const at = "2026-09-09T00:00:00Z";
const response = (text = "Hello", lastSeq = 1) => ({
  thread: { id: "a", last_seq: lastSeq, status: "running" },
  transcript: [
    {
      role: "assistant",
      id: "message",
      seq: 1,
      at,
      text,
      complete: false,
      turn_id: "turn",
      origin: { kind: "root" },
    },
  ],
  pending_approvals: [],
  next_before_seq: null,
});

test("reopening an unchanged thread returns the same snapshot without a refresh", () => {
  const cache = new ThreadCache();
  const snapshot = seedFromGet(response());
  cache.set("a", snapshot);
  cache.set("b", seedFromGet(response("Other")));
  cache.touch("a");
  assert.equal(cache.get("a"), snapshot);
  assert.equal(cache.isStale("a"), false);
});

test("closed-thread updates retain readable content until a buffered refresh replaces it", () => {
  const cache = new ThreadCache();
  const old = seedFromGet(response());
  cache.set("a", old);
  cache.invalidate("a");
  assert.equal(cache.get("a"), old);
  assert.equal(cache.isStale("a"), true);
  const revision = cache.revision("a");
  const delta = {
    kind: "assistant_text_delta",
    message_id: "message",
    origin: { kind: "root" },
    delta: "!",
    seq: 3,
    thread_id: "a",
    turn_id: "turn",
    at,
  };
  const next = applyEvent(seedFromGet(response("Hello world", 2)), delta);
  cache.set("a", retainHistoryIdentities(next, old));
  assert.equal(cache.markFresh("a", revision), true);
  assert.equal(cache.get("a").blocks[0].text, "Hello world!");
  assert.equal(cache.get("a").lastSeq, 3);
  assert.equal(cache.isStale("a"), false);
});

test("a failed refresh leaves cached content and its retry requirement intact", () => {
  const cache = new ThreadCache();
  const snapshot = seedFromGet(response());
  cache.set("a", snapshot);
  cache.invalidateAll();
  // No successful replacement or markFresh when the request rejects.
  assert.equal(cache.get("a"), snapshot);
  assert.equal(cache.isStale("a"), true);
});

test("a disconnect during hydration cannot mark its old result current", () => {
  const cache = new ThreadCache();
  for (const initial of [false, true]) {
    cache.clear();
    if (!initial) cache.set("a", seedFromGet(response()));
    const oldRevision = cache.revision("a");
    cache.invalidateAll();
    cache.set("a", seedFromGet(response("Response before reconnect", 2)));
    assert.equal(cache.markFresh("a", oldRevision), false);
    assert.equal(cache.isStale("a"), true);
    const freshRevision = cache.revision("a");
    cache.set("a", seedFromGet(response("Caught up", 4)));
    assert.equal(cache.markFresh("a", freshRevision), true);
  }
});

test("eviction follows visits, protects visible and pending work, and clears stale metadata", () => {
  const cache = new ThreadCache();
  for (const id of ["a", "b", "c", "d"]) cache.set(id, { id });
  cache.invalidate("b");
  cache.touch("a");
  cache.trim(3, (id) => id === "c");
  assert.deepEqual([...cache.keys()], ["c", "d", "a"]);
  assert.equal(cache.isStale("b"), false);
  cache.set("c", { id: "c", streamed: true });
  cache.set("e", { id: "e" });
  cache.trim(3, (id) => id === "c");
  assert.deepEqual([...cache.keys()], ["c", "a", "e"]);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.isStale("a"), false);
});
