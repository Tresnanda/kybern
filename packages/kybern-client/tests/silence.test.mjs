import assert from "node:assert/strict";
import test from "node:test";
import { silenceNotice } from "../src/silence.ts";

test("a turn says nothing about silence until a minute has passed", () => {
  assert.equal(silenceNotice(59_000, "Claude"), null);
  assert.equal(silenceNotice(60_000, "Claude"), "No response from Claude for 60 s");
  assert.equal(silenceNotice(119_900, "Codex"), "No response from Codex for 119 s");
  assert.equal(silenceNotice(409_000, "Claude"), "No response from Claude for 6 min");
  assert.equal(silenceNotice(Number.NaN, "Claude"), null);
});
