import assert from "node:assert/strict";
import test from "node:test";
import { applyIndexEvent } from "../src/state/indexProjection.ts";
import {
  seedFromGet,
  applyEvent,
} from "../../../packages/kybern-client/src/transcript.ts";
const thread = {
  id: "thread",
  project_id: "project",
  title: "Build the app",
  provider: { kind: "codex", instance: "default" },
  permission_mode: "supervised",
  status: "idle",
  cwd: "/tmp/project",
  pinned: false,
  created_at: "2026-09-08T00:00:00Z",
  updated_at: "2026-09-08T00:00:00Z",
  last_seq: 4,
};
const event = (payload, seq) => ({
  thread_id: thread.id,
  turn_id: "turn",
  at: thread.created_at,
  seq,
  ...payload,
});
const initial = () => ({ threads: [thread], approvals: [], queue: [] });
test("buffered start and completion events reconcile over a stale list snapshot", () => {
  let state = initial();
  state = applyIndexEvent(
    state,
    event(
      { kind: "turn_started", message_id: "message", message: { parts: [] } },
      5,
    ),
  );
  assert.equal(state.threads[0]?.status, "running");
  state = applyIndexEvent(state, event({ kind: "turn_completed" }, 6));
  assert.equal(state.threads[0]?.status, "idle");
  assert.equal(state.threads[0]?.last_seq, 6);
  state = applyIndexEvent(
    state,
    event(
      { kind: "turn_started", message_id: "message", message: { parts: [] } },
      5,
    ),
  );
  assert.equal(
    state.threads[0]?.status,
    "idle",
    "a replay must not rewind a newer snapshot",
  );
});
test("background text deltas preserve index identity", () => {
  const state = initial();
  assert.equal(
    applyIndexEvent(
      state,
      event(
        {
          kind: "assistant_text_delta",
          message_id: "m",
          origin: { kind: "root" },
          delta: "Hello",
        },
        5,
      ),
    ),
    state,
  );
});
test("queue receipts are idempotent and turn start removes the consumed follow-up", () => {
  const message = { id: "q", thread_id: thread.id, message: { parts: [] } };
  let state = applyIndexEvent(
    initial(),
    event({ kind: "message_queued", message }, 5),
  );
  state = applyIndexEvent(state, event({ kind: "message_queued", message }, 5));
  assert.equal(state.queue.length, 1);
  state = applyIndexEvent(
    state,
    event(
      { kind: "turn_started", message_id: "q", message: message.message },
      6,
    ),
  );
  assert.equal(state.queue.length, 0);
});
test("an approval resolved during hydration does not reappear", () => {
  const approval = {
    id: "a",
    thread_id: "thread",
    turn_id: "turn",
    tool_name: "Bash",
    input: {},
    summary: "Run tests",
    suggestions: [],
    created_at: thread.created_at,
  };
  const state = applyIndexEvent(
    { ...initial(), approvals: [approval] },
    event(
      {
        kind: "approval_resolved",
        approval_id: "a",
        decision: { decision: "allow_once" },
      },
      6,
    ),
  );
  assert.deepEqual(state.approvals, []);
});
test("transcript hydration applies only events after its acknowledged sequence", () => {
  const response = {
    thread: { ...thread, last_seq: 6 },
    pending_approvals: [],
    transcript: [
      {
        role: "assistant",
        id: "m",
        turn_id: "turn",
        seq: 5,
        at: thread.created_at,
        origin: { kind: "root" },
        text: "Hello",
        complete: false,
      },
    ],
  };
  let state = seedFromGet(response);
  state = applyEvent(
    state,
    event(
      {
        kind: "assistant_text_delta",
        message_id: "m",
        origin: { kind: "root" },
        delta: "Hello",
      },
      5,
    ),
  );
  state = applyEvent(
    state,
    event(
      {
        kind: "assistant_text_delta",
        message_id: "m",
        origin: { kind: "root" },
        delta: " world",
      },
      7,
    ),
  );
  assert.equal(state.blocks.length, 1);
  assert.equal(
    state.blocks[0]?.kind === "assistant" && state.blocks[0].text,
    "Hello world",
  );
});


test("queue edits retain order and never resurrect a consumed prompt", () => {
  const first = { id: "first", thread_id: thread.id, message: { parts: [{ type: "text", text: "Original" }] } };
  const second = { id: "second", thread_id: thread.id, message: { parts: [] } };
  let state = { ...initial(), queue: [first, second] };
  const edited = { ...first, message: { parts: [{ type: "text", text: "Edited" }] } };
  state = applyIndexEvent(state, event({ kind: "message_queue_updated", message: edited }, 7));
  assert.deepEqual(state.queue, [edited, second]);
  state = applyIndexEvent(state, event({ kind: "message_removed", message_id: "first" }, 8));
  state = applyIndexEvent(state, event({ kind: "message_queue_updated", message: edited }, 9));
  assert.deepEqual(state.queue, [second]);
});

import * as mobile from "../src/state/transcript.ts";
test("mobile notes hydrate and update independently of transcript rows and provider tasks", () => {
  let state = mobile.seedFromGet({ thread, transcript: [], pending_approvals: [], notes: { text: "From desktop", revision: 2 } });
  const blocks = state.blocks;
  state = mobile.applyEvent(state, event({ kind: "thread_notes_updated", notes: { text: "From phone", revision: 3 } }, 5));
  assert.equal(state.notes.text, "From phone");
  assert.equal(state.blocks, blocks);
  assert.deepEqual(state.tasks, []);
});
