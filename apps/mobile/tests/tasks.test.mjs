import assert from "node:assert/strict";
import test from "node:test";
import { applyEvent, seedFromGet } from "../src/state/transcript.ts";
const at = "2026-09-08T00:00:00Z";
const thread = { id: "thread", last_seq: 10, status: "idle" };
const task = {
  id: "agent",
  thread_id: "thread",
  origin_turn_id: "turn",
  started_seq: 2,
  updated_seq: 8,
  kind: "agent",
  status: "running",
  title: "Review",
  backgrounded: true,
  stats: {},
  capabilities: { stop: true, background: true },
  started_at: at,
  updated_at: at,
};
const event = (seq, payload) => ({
  seq,
  at,
  thread_id: "thread",
  turn_id: "turn",
  ...payload,
});
const response = () => ({
  thread,
  pending_approvals: [],
  runtime_tasks: [task],
  transcript: [
    {
      role: "assistant",
      id: "root",
      origin: { kind: "root" },
      text: "Root answer",
      complete: true,
      seq: 3,
      turn_id: "turn",
      at,
    },
    {
      role: "assistant",
      id: "child",
      origin: { kind: "agent", task_id: "agent" },
      text: "Checking files",
      complete: false,
      seq: 4,
      turn_id: "turn",
      at,
    },
    {
      role: "tool_call",
      origin: { kind: "agent", task_id: "agent" },
      call: { id: "tool", name: "Read", input: {} },
      complete: false,
      is_error: false,
      seq: 5,
      turn_id: "turn",
      at,
    },
  ],
});
test("rehydration restores background tasks and separates agent transcript from parent", () => {
  const state = seedFromGet(response());
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].backgrounded, true);
  assert.equal(state.blocks.filter((b) => b.kind === "assistant").length, 1);
  assert.equal(
    state.blocks.find((b) => b.kind === "runtime_task").task.id,
    "agent",
  );
  assert.equal(state.taskActivity.agent.length, 2);
  assert.equal(state.taskActivity.agent[0].text, "Checking files");
});
test("agent tool output without an origin stays attached to its agent", () => {
  let state = seedFromGet(response());
  state = applyEvent(
    state,
    event(11, {
      kind: "tool_call_output_delta",
      tool_call_id: "tool",
      delta: "hello",
    }),
  );
  state = applyEvent(
    state,
    event(12, {
      kind: "tool_call_completed",
      tool_call_id: "tool",
      output: "hello",
      is_error: false,
    }),
  );
  assert.equal(state.taskActivity.agent[1].output, "hello");
  assert.equal(state.taskActivity.agent[1].complete, true);
  assert.equal(
    state.blocks.some((b) => b.kind === "tool"),
    false,
  );
});
test("background agent continues after foreground completion and settles its controls", () => {
  let state = seedFromGet(response());
  state = applyEvent(
    state,
    event(11, {
      kind: "assistant_text_delta",
      message_id: "child",
      origin: { kind: "agent", task_id: "agent" },
      delta: " done",
    }),
  );
  state = applyEvent(
    state,
    event(12, {
      kind: "runtime_task_completed",
      task: {
        ...task,
        status: "completed",
        capabilities: { stop: false, background: false },
      },
    }),
  );
  assert.equal(state.taskActivity.agent.at(-1).text, " done");
  assert.equal(state.tasks[0].status, "completed");
  state = applyEvent(state, event(13, { kind: "runtime_task_updated", task }));
  assert.equal(
    state.tasks[0].status,
    "completed",
    "a late active update cannot revive a completed task",
  );
  assert.equal(state.tasks[0].capabilities.stop, false);
});
test("a nested subagent retains its parent and its own output across reconnect", () => {
  const result = response();
  result.runtime_tasks.push({ ...task, id: "nested", parent_id: "agent" });
  result.transcript.push({
    role: "assistant",
    id: "nested-output",
    origin: { kind: "agent", task_id: "nested" },
    text: "Nested result",
    complete: true,
    seq: 9,
    turn_id: "turn",
    at,
  });
  const state = seedFromGet(result);
  assert.equal(state.tasks.find((t) => t.id === "nested").parent_id, "agent");
  assert.equal(state.taskActivity.nested[0].text, "Nested result");
  assert.equal(state.taskActivity.agent.length, 2);
});
