import assert from "node:assert/strict";
import test from "node:test";
import { accountLabel } from "../src/state/accountLabel.ts";

test("a thread that already ran names the computer's own login, never the default", () => {
  assert.equal(accountLabel("default", true), "CLI account");
});

test("a new chat and a thread that hasn't run follow the default", () => {
  assert.equal(accountLabel("default"), "Default");
  assert.equal(accountLabel("default", false), "Default");
});

test("a named account reads the same either way", () => {
  assert.equal(accountLabel("work", true), "Work");
  assert.equal(accountLabel("work"), "Work");
});
