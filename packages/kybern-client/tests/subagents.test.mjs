import test from "node:test";
import assert from "node:assert/strict";
import { isSubagentThread, subagentPhase, withoutSubagents } from "../src/subagents.ts";

test("subagent threads are recognised and filtered out of user lists", () => {
  const user = { id: "a" };
  const child = { id: "b", subagent: { task_id: "t", status: "running" } };
  assert.equal(isSubagentThread(child), true);
  assert.equal(isSubagentThread(user), false);
  assert.equal(isSubagentThread(undefined), false);
  assert.deepEqual(withoutSubagents([user, child]), [user]);
  const same = [user];
  assert.equal(withoutSubagents(same), same, "nothing to remove keeps the array identity");
});

test("task states collapse into working, done, failed and stopped", () => {
  const phases = Object.fromEntries(
    ["pending", "running", "waiting", "stopping", "completed", "failed", "stopped", "interrupted"].map((status) => [status, subagentPhase(status)]),
  );
  assert.deepEqual(phases, {
    pending: "working", running: "working", waiting: "working", stopping: "working",
    completed: "done", failed: "failed", stopped: "stopped", interrupted: "stopped",
  });
});
