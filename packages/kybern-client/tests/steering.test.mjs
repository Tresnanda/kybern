import assert from "node:assert/strict";
import test from "node:test";
import { canSteer, STEERABLE } from "../src/steering.ts";

test("claude-code, codex, pi and omp take a steer", () => {
  assert.deepEqual([...STEERABLE], ["claude-code", "codex", "pi", "omp"]);
  for (const kind of STEERABLE) assert.equal(canSteer(kind), true, kind);
});

test("opencode and cursor only queue", () => {
  assert.equal(canSteer("opencode"), false);
  assert.equal(canSteer("cursor"), false);
});

test("a provider object works like its kind", () => {
  assert.equal(canSteer({ kind: "claude-code", instance: "default" }), true);
  assert.equal(canSteer({ kind: "cursor" }), false);
});

test("a missing provider does not steer", () => {
  assert.equal(canSteer(undefined), false);
  assert.equal(canSteer(null), false);
  assert.equal(canSteer(""), false);
});
