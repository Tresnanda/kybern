import assert from "node:assert/strict";
import test from "node:test";
import {
  sendTravel,
  sendProgress,
  sendEndpointOffset,
} from "../src/components/liquid/sendGeometry.ts";

const from = { x: 36, y: 460 };
const to = { x: 350, y: 360 };
function position(p, keyboard, targetY) {
  const path = sendTravel(p);
  const offset = sendEndpointOffset(p, -300, keyboard, 0, targetY);
  return {
    x: from.x + (to.x - from.x) * path.x + offset.x,
    y: from.y + (to.y - from.y) * path.y + offset.y,
  };
}

test("departure leads right while both axes keep travelling into the final approach", () => {
  const early = sendTravel(0.1);
  const middle = sendTravel(0.5);
  const late = sendTravel(0.9);
  assert.ok(early.x >= 0.1 && early.y < 0.005);
  assert.ok(middle.x >= 0.5 && middle.x <= 0.6 && middle.y < 0.15);
  assert.ok(late.x >= 0.9 && late.x < 0.95 && late.y < 0.75);
  assert.deepEqual(sendTravel(0), { x: 0, y: 0 });
  assert.deepEqual(sendTravel(1), { x: 1, y: 1 });
});

test("keyboard descent translates the curve without turning it into an upward-first arc", () => {
  for (let frame = 0; frame <= 20; frame++) {
    const p = frame / 20;
    const descent = p * 300;
    const moving = position(p, -300 + descent, descent);
    const stationary = position(p, -300, 0);
    assert.ok(Math.abs(moving.y - descent - stationary.y) < 0.001);
    assert.equal(moving.x, stationary.x);
  }
});

test("a fast timing curve cannot land ahead of a slower native keyboard", () => {
  assert.equal(sendProgress(0.5, -300, -300), 0);
  assert.ok(sendProgress(0.7, -300, -297) > 0);
  assert.equal(sendProgress(1, -300, -225), 0.25);
  assert.equal(sendProgress(1, -300, -150), 0.5);
  assert.equal(sendProgress(1, -300, 0), 1);
});

test("the whole send begins during dismissal and follows the rightward leg before rising", () => {
  const p = sendProgress(0.6, -300, -240);
  const moving = position(p, -240, 60);
  // Already travelling while 80% of the keyboard remains visible.
  assert.ok(moving.x - from.x > 60);
  // Relative to the descending composer, less than 2 dp of the rise has happened.
  const rise = from.y + 60 - moving.y;
  assert.ok(rise > 0 && rise < 2);
  assert.deepEqual(position(sendProgress(1, -300, 0), 0, 300), {
    x: 350,
    y: 660,
  });
});

test("closed-keyboard sends use timing normally and all progress is bounded", () => {
  assert.equal(sendProgress(0.4, 0, 0), 0.4);
  assert.equal(sendProgress(1, 0, 0), 1);
  assert.equal(sendProgress(-1, 0, 0), 0);
  assert.equal(sendProgress(2, -300, 0), 1);
  assert.deepEqual(sendTravel(-1), { x: 0, y: 0 });
  assert.deepEqual(sendTravel(2), { x: 1, y: 1 });
});

test("landing follows actual destination displacement, including independent list movement", () => {
  assert.deepEqual(sendEndpointOffset(1, -300, -120, 20, 85), { x: 20, y: 85 });
  assert.deepEqual(sendEndpointOffset(1, -300, 0, 20, -190), {
    x: 20,
    y: -190,
  });
});

test("both axes retain visible travel near landing with and without keyboard dismissal", () => {
  for (const keyboardAtSend of [0, -300]) {
    const frames = [0.8, 0.9, 0.95, 0.99, 1].map((t) => {
      const keyboardNow = keyboardAtSend * (1 - t);
      return sendTravel(sendProgress(t, keyboardAtSend, keyboardNow));
    });
    for (let i = 0; i < frames.length - 1; i++) {
      const here = frames[i];
      const next = frames[i + 1];
      assert.ok(here.x < 1 && here.y < 1);
      assert.ok(next.x > here.x && next.y > here.y);
      // X must not have a visually finished plateau while Y is still rising.
      assert.ok(1 - here.x >= (1 - here.y) / 4 - 1e-10);
    }
    assert.deepEqual(frames.at(-1), { x: 1, y: 1 });
  }
});

test("the curved path eases X and turns upward continuously without an early horizontal stop", () => {
  const step = 0.001;
  const velocity = (p) => {
    const a = sendTravel(p);
    const b = sendTravel(p + step);
    return { x: (b.x - a.x) / step, y: (b.y - a.y) / step };
  };
  const start = velocity(0);
  const middle = velocity(0.5);
  const end = velocity(0.999);
  assert.ok(start.x > middle.x && middle.x > end.x);
  assert.ok(start.y < middle.y && middle.y < end.y);
  assert.ok(end.x > 0.7); // Both axes remain active all the way to arrival.
  let previous = start;
  for (let i = 1; i < 999; i++) {
    const next = velocity(i * step);
    assert.ok(next.x > 0 && next.y > 0);
    assert.ok(next.x <= previous.x && next.y >= previous.y);
    assert.ok(Math.abs(next.x - previous.x) < 0.01);
    assert.ok(Math.abs(next.y - previous.y) < 0.01);
    previous = next;
  }
});
