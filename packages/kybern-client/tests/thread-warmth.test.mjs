import test from "node:test";
import assert from "node:assert/strict";
import { backgroundThreads, createLinger, createPrefetchQueue } from "../src/threadWarmth.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("prefetch fetches only the top rows, two at a time, skipping known ones", async () => {
  const started = [];
  const finish = new Map();
  const queue = createPrefetchQueue({
    run: (id) => {
      started.push(id);
      return new Promise((resolve) => finish.set(id, resolve));
    },
    skip: (id) => id === "cached",
    limit: 4,
  });
  queue.want(["a", "cached", "b", "c", "d", "e", "f"]);
  assert.deepEqual(started, ["a", "b"]);
  finish.get("a")();
  await tick();
  assert.deepEqual(started, ["a", "b", "c"]);
  finish.get("b")();
  finish.get("c")();
  await tick();
  await tick();
  assert.deepEqual(started, ["a", "b", "c", "d"], "e and f are past the limit");
  finish.get("d")();
  await tick();
  queue.want(["a", "b", "e"]);
  assert.deepEqual(started.slice(4), ["e"], "fetched rows are not fetched again");
});

test("hover puts a row first", async () => {
  const started = [];
  const queue = createPrefetchQueue({ run: (id) => (started.push(id), new Promise(() => {})), concurrency: 1 });
  queue.want(["a", "b", "c"]);
  queue.bump("c");
  assert.deepEqual(started, ["a"]);
  queue.dispose();
});

test("a closed thread lingers, then expires; reopening keeps it", () => {
  const timers = new Map();
  let next = 1;
  const fake = {
    setTimeout: (fn) => (timers.set(next, fn), next++),
    clearTimeout: (id) => timers.delete(id),
  };
  const expired = [];
  const linger = createLinger({ expire: (id) => expired.push(id), timers: fake, max: 2 });
  linger.release("a");
  assert.equal(linger.hold("a"), true);
  assert.equal(timers.size, 0);
  linger.release("a");
  linger.release("b");
  linger.release("c");
  assert.deepEqual(expired, ["a"], "past max, the oldest release goes");
  for (const fn of [...timers.values()]) fn();
  assert.deepEqual(expired, ["a", "b", "c"]);
  assert.equal(linger.has("b"), false);
});

test("background subscriptions keep the eight most recently viewed running threads", () => {
  const recent = Array.from({ length: 12 }, (_, n) => `t${n}`);
  const running = new Set(["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10"]);
  assert.deepEqual(backgroundThreads(recent, running), ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"]);
});
