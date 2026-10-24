import assert from "node:assert/strict";
import test from "node:test";
import { runtimeTaskState, runtimeTaskStatusWord } from "../src/statusWords.ts";
import { childState } from "../src/delegations.ts";

const STATUSES = ["pending", "running", "waiting", "stopping", "completed", "failed", "stopped", "interrupted"];

test("every runtime task status has a sentence-case word", () => {
  assert.deepEqual(STATUSES.map((status) => runtimeTaskStatusWord(status)), ["Starting", "Running", "Waiting", "Stopping", "Completed", "Failed", "Stopped", "Interrupted"]);
  for (const status of STATUSES) assert.match(runtimeTaskStatusWord(status), /^[A-Z][a-z ]+$/);
});

test("a backgrounded task says where it runs", () => {
  assert.equal(runtimeTaskStatusWord("running", true), "Running in background");
  assert.equal(runtimeTaskStatusWord("waiting", true), "Monitoring in background");
  assert.equal(runtimeTaskStatusWord("completed", true), "Completed");
});

test("phases follow the glyphs: spinner, check, cross, stop", () => {
  const phases = Object.fromEntries(STATUSES.map((status) => [status, runtimeTaskState(status).phase]));
  assert.deepEqual(phases, { pending: "working", running: "working", waiting: "working", stopping: "working", completed: "done", failed: "failed", stopped: "stopped", interrupted: "stopped" });
});

test("a delegated child and a task that failed share the word and phase", () => {
  const child = childState({ id: "c", delegation: { status: "failed" } });
  assert.deepEqual(child, runtimeTaskState("failed"));
});
