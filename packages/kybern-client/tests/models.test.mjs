import assert from "node:assert/strict";
import test from "node:test";
import { findModel } from "../src/models.ts";

const catalog = [
  { id: "opus[1m]", display_name: "Claude Opus 5.5 · 1M", resolved_id: "claude-opus-5-5[1m]" },
  { id: "claude-fable-5-1[1m]", display_name: "Claude Fable 5.1 · 1M", resolved_id: "claude-fable-5-1" },
  { id: "claude-opus-4-8", display_name: "Claude Opus 4.8", resolved_id: "claude-opus-4-8" },
];

test("a thread's model matches its selector or the model the selector runs", () => {
  assert.equal(findModel(catalog, "opus[1m]")?.id, "opus[1m]");
  assert.equal(findModel(catalog, "claude-fable-5-1")?.id, "claude-fable-5-1[1m]");
  assert.equal(findModel(catalog, "claude-opus-4-8")?.id, "claude-opus-4-8");
});

test("a session's concrete id matches across a context suffix", () => {
  assert.equal(findModel(catalog, "claude-opus-5-5")?.id, "opus[1m]");
  assert.equal(findModel(catalog, "claude-fable-5-1[1m]")?.id, "claude-fable-5-1[1m]");
  assert.equal(findModel(catalog, "claude-sonnet-5"), undefined);
  assert.equal(findModel(catalog, ""), undefined);
});
