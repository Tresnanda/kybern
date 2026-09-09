import assert from "node:assert/strict";
import test from "node:test";
import { sendTravel, sendEndpointOffset } from "../src/components/liquid/sendGeometry.ts";

// Pixel coordinates from the keyboard-visible text-send regression: the
// keyboard moves down 300 dp while both the composer and newest row move.
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

test("a pending flight stays with its composer while the keyboard closes", () => {
  assert.deepEqual(position(0, -300, 0), from);
  assert.deepEqual(position(0, -150, 150), { x: 36, y: 610 });
  assert.deepEqual(position(0, 0, 300), { x: 36, y: 760 });
});

test("keyboard motion translates the entire curve instead of reversing its direction", () => {
  for (const p of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
    const open = position(p, -300, 0);
    const closing = position(p, -180, 120);
    const closed = position(p, 0, 300);
    assert.ok(Math.abs(closing.y - open.y - 120) < 0.001);
    assert.ok(Math.abs(closed.y - open.y - 300) < 0.001);
    assert.equal(closed.x, open.x);
  }
});

test("travel departs to the right before rising and arrives vertically without overshoot", () => {
  const early = position(0.1, 0, 300);
  const middle = position(0.5, 0, 300);
  const late = position(0.9, 0, 300);
  assert.ok((early.x - from.x) / (to.x - from.x) > 0.18);
  assert.ok(760 - early.y < 2);
  assert.ok(middle.x > 270 && middle.y > 730);
  assert.ok(to.x - late.x < 4 && late.y > 670);
  assert.deepEqual(position(1, 0, 300), { x: 350, y: 660 });
  assert.deepEqual(sendTravel(-1), { x: 0, y: 0 });
  assert.deepEqual(sendTravel(2), { x: 1, y: 1 });
});

test("landing discards source keyboard movement and follows the actual destination", () => {
  assert.deepEqual(sendEndpointOffset(1, -300, -120, 20, 85), { x: 20, y: 85 });
  assert.deepEqual(sendEndpointOffset(1, 0, -280, 20, -190), { x: 20, y: -190 });
});
