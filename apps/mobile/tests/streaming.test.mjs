import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceReveal,
  revealBoundary,
  MAX_BACKLOG,
} from "../src/lib/streamPacing.ts";

test("bursty ingress is revealed monotonically and drains to exact final Unicode text", () => {
  const text =
    "### Notes\n\nHello **world** 👩🏽‍💻 and café.\n\n```ts\nconst value = 42;\n```\n\n".repeat(
      30,
    );
  let position = 0;
  let shown = "";
  let target = "";
  for (let frame = 0; frame < 4000 && shown !== text; frame++) {
    if (frame % 15 === 0)
      target = text.slice(0, Math.min(text.length, target.length + 130));
    position = advanceReveal(position, target.length, 1000 / 60);
    const next = target.slice(0, revealBoundary(target, position));
    assert.ok(next.startsWith(shown));
    assert.ok(text.startsWith(next));
    shown = next;
  }
  assert.equal(shown, text);
});

test("large bursts have bounded backlog, short input drains, and corrections reset", () => {
  let position = advanceReveal(0, 100_000, 16);
  assert.ok(100_000 - position <= MAX_BACKLOG);
  assert.equal(advanceReveal(position, 3, 16), 3);
  position = 0;
  for (let t = 0; t < 500; t += 16) position = advanceReveal(position, 1, 16);
  assert.equal(position, 1);
  assert.equal(advanceReveal(1, 20, 0), 1);
});

test("reveal boundaries preserve surrogate pairs and received joined emoji", () => {
  assert.equal(revealBoundary("A😀B", 2), 1);
  assert.equal(revealBoundary("A😀B", 3), 3);
  const emoji = "👩🏽‍💻";
  for (let i = 2; i <= emoji.length; i++)
    assert.equal(revealBoundary(emoji, i), emoji.length);
  assert.equal(revealBoundary("éx", 1), 2);
});
