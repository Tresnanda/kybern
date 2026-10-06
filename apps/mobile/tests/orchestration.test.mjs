import assert from "node:assert/strict";
import test from "node:test";
import { applyIndexEvent } from "../src/state/indexProjection.ts";
import { groupInlineParts, isInlinePart } from "../src/state/inlineMessage.ts";
import {
  childIsRunning,
  childStatusWord,
  firstLine,
  hasOrchestrationParts,
  orchestrationLabel,
  resultLocation,
  resultSummary,
  sortChildren,
  threadMessageHeading,
} from "../src/state/orchestration.ts";

const thread = {
  id: "child",
  project_id: "project",
  title: "Review the diff",
  provider: { kind: "codex", instance: "default" },
  permission_mode: "supervised",
  status: "idle",
  cwd: "/tmp/project",
  pinned: false,
  created_at: "2026-10-06T00:00:00Z",
  updated_at: "2026-10-06T00:00:00Z",
  last_seq: 1,
  parent_thread_id: "parent",
};
const delegation = (status) => ({
  task_id: "task",
  operation_id: "op",
  parent_thread_id: "parent",
  depth: 1,
  role: "review",
  workspace: "shared",
  status,
  started_at: thread.created_at,
});
const message = {
  type: "thread_message",
  message_id: "m1",
  from_thread_id: "parent",
  from_title: "Planner",
  purpose: "question",
  body: "Which branch?",
};
const item = {
  task_id: "t1",
  thread_id: "child",
  title: "Review",
  provider: "codex",
  role: "review",
  status: "completed",
  result: "\n  Looks good.\nSecond line",
  workspace: "shared",
  files_touched: ["a.ts", "b.ts"],
};
const results = { type: "agent_results", items: [item] };

test("agent messages and results are not inline text and are recognised", () => {
  for (const part of [message, results]) {
    assert.equal(isInlinePart(part), false);
    assert.equal(hasOrchestrationParts({ parts: [part] }), true);
  }
  assert.equal(hasOrchestrationParts({ parts: [{ type: "text", text: "hi" }] }), false);
  const groups = groupInlineParts(
    [{ type: "text", text: "a" }, message, results].map((part, index) => ({ part, index })),
  );
  assert.deepEqual(groups.map((g) => g.inline), [true, false, false]);
});

test("a thread message names its sender and purpose", () => {
  assert.equal(threadMessageHeading(message), "Question · Planner");
  assert.equal(
    threadMessageHeading({ ...message, from_thread_id: null, from_title: "", purpose: "warning" }),
    "Warning · Kybern",
  );
});

test("agent results summarise to one line with branch or file count", () => {
  assert.equal(resultSummary(item), "Looks good.");
  assert.equal(resultSummary({ ...item, result: null, error: "Boom\nstack" }), "Boom");
  assert.equal(resultSummary({ ...item, result: null, status: "running" }), "Still working");
  assert.equal(resultLocation(item), "2 files touched");
  assert.equal(resultLocation({ ...item, files_touched: ["a"] }), "1 file touched");
  assert.equal(resultLocation({ ...item, workspace: "worktree", branch: "kybern/x" }), "kybern/x");
  assert.equal(resultLocation({ ...item, files_touched: undefined }), "");
  assert.equal(firstLine("x".repeat(200), 10).length, 10);
});

test("queued relays get a one-line label", () => {
  assert.equal(orchestrationLabel({ parts: [{ type: "text", text: "hi" }] }), null);
  assert.equal(orchestrationLabel({ parts: [message] }), "Question · Planner: Which branch?");
  assert.equal(orchestrationLabel({ parts: [results] }), "Agent result");
});

test("child rows use the delegation, subagent or thread status word", () => {
  assert.equal(childStatusWord({ ...thread, delegation: delegation("completed") }), "Completed");
  assert.equal(childIsRunning({ ...thread, delegation: delegation("running") }), true);
  assert.equal(childIsRunning({ ...thread, delegation: delegation("failed"), status: "running" }), false);
  const subagent = { task_id: "x", root_thread_id: "parent", parent_turn_id: "t", status: "waiting" };
  assert.equal(childStatusWord({ ...thread, subagent }), "Waiting");
  assert.equal(childIsRunning({ ...thread, subagent }), true);
  assert.equal(childStatusWord({ ...thread, status: "awaiting-approval" }), "Needs approval");
  const later = { ...thread, id: "b", created_at: "2026-10-06T01:00:00Z" };
  assert.deepEqual(sortChildren([later, thread]).map((t) => t.id), ["child", "b"]);
});

test("delegated children stay out of the thread index like subagents", () => {
  const state = { threads: [], approvals: [], queue: [] };
  const created = (t) => ({ kind: "thread_created", thread: t, seq: 1, thread_id: t.id, at: t.created_at });
  assert.equal(applyIndexEvent(state, created({ ...thread, delegation: delegation("running") })), state);
  assert.equal(applyIndexEvent(state, created(thread)).threads.length, 1);
});
