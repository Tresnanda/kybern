import test from "node:test";
import assert from "node:assert/strict";
import { createSyncIndicator } from "../src/syncIndicator.ts";

function clock() {
  let now = 0;
  const timers = new Map();
  let next = 1;
  return {
    now: () => now,
    timers: {
      setTimeout(fn, ms) {
        timers.set(next, { at: now + ms, fn });
        return next++;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.fn();
      }
    },
  };
}

test("a load faster than 400 ms never shows the indicator", () => {
  const c = clock();
  const changes = [];
  const indicator = createSyncIndicator({ onChange: (v) => changes.push(v), now: c.now, timers: c.timers });
  indicator.start();
  c.advance(399);
  indicator.stop();
  c.advance(1000);
  assert.deepEqual(changes, []);
});

test("once shown, the indicator stays at least 400 ms", () => {
  const c = clock();
  const changes = [];
  const indicator = createSyncIndicator({ onChange: (v) => changes.push([v, c.now()]), now: c.now, timers: c.timers });
  indicator.start();
  c.advance(450);
  indicator.stop();
  c.advance(100);
  assert.equal(indicator.visible, true);
  c.advance(300);
  assert.deepEqual(changes, [
    [true, 450],
    [false, 850],
  ]);
});

test("a new load while the indicator is about to hide keeps it up", () => {
  const c = clock();
  const changes = [];
  const indicator = createSyncIndicator({ onChange: (v) => changes.push(v), now: c.now, timers: c.timers });
  indicator.start();
  c.advance(400);
  indicator.stop();
  c.advance(100);
  indicator.start();
  c.advance(1000);
  assert.deepEqual(changes, [true]);
  indicator.stop();
  assert.deepEqual(changes, [true, false]);
});
