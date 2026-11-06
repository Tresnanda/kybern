import test from "node:test";
import assert from "node:assert/strict";
import { applyThreadList, moreParams, refreshParams } from "../src/threadListCursor.ts";

const thread = (id, extra = {}) => ({
  id,
  project_id: "p",
  title: id,
  status: "idle",
  pinned: false,
  last_seq: 1,
  updated_at: "2026-11-01T00:00:00Z",
  ...extra,
});

test("a daemon without cursors gets the full list every time and rows keep their identity", () => {
  const a = thread("a");
  const first = applyThreadList(undefined, refreshParams(undefined), { threads: [a, thread("b")] });
  assert.equal(first.headSeq, undefined);
  assert.deepEqual(refreshParams(first), { settled_limit: 25 });
  const second = applyThreadList(first, refreshParams(first), { threads: [{ ...a }, thread("b", { last_seq: 2 })] });
  assert.equal(second.threads[0], first.threads[0], "unchanged row is the same object");
  assert.notEqual(second.threads[1], first.threads[1]);
});

test("changed rows merge into the list; unchanged ones stay identical", () => {
  const first = applyThreadList(undefined, { settled_limit: 25 }, {
    threads: [thread("a"), thread("b"), thread("c")],
    activity: [{ thread_id: "a", active_agents: 1, active_processes: 0, active_monitors: 0 }],
    head_seq: 10,
    omitted: [{ project_id: "p", count: 40 }],
  });
  assert.equal(first.headSeq, 10);
  assert.deepEqual(first.omitted, { p: 40 });
  assert.deepEqual(refreshParams(first), { since_seq: 10 });

  const next = applyThreadList(first, { since_seq: 10 }, {
    threads: [thread("a", { last_seq: 12 }), thread("d", { last_seq: 11 })],
    activity: [],
    head_seq: 12,
  });
  assert.equal(next.headSeq, 12);
  assert.deepEqual(next.threads.map((t) => t.id), ["d", "a", "b", "c"]);
  assert.equal(next.threads[2], first.threads[1]);
  assert.equal(next.threads[3], first.threads[2]);
  assert.deepEqual(next.activity, [], "a returned thread without a summary loses its activity");
  assert.equal(next.omitted, first.omitted);
});

test("an empty delta keeps every array identical", () => {
  const first = applyThreadList(undefined, {}, {
    threads: [thread("a")],
    activity: [{ thread_id: "a", active_agents: 1, active_processes: 0, active_monitors: 0 }],
    head_seq: 3,
  });
  const next = applyThreadList(first, { since_seq: 3 }, { threads: [], activity: [], head_seq: 5 });
  assert.equal(next.threads, first.threads);
  assert.equal(next.activity, first.activity);
  assert.equal(next.headSeq, 5);
});

test("archived rows leave a list that hides them", () => {
  const first = applyThreadList(undefined, {}, { threads: [thread("a"), thread("b")], head_seq: 3 });
  const next = applyThreadList(first, { since_seq: 3 }, { threads: [thread("a", { status: "archived", last_seq: 4 })], head_seq: 4 });
  assert.deepEqual(next.threads.map((t) => t.id), ["b"]);
  const kept = applyThreadList(first, { since_seq: 3, include_archived: true }, {
    threads: [thread("a", { status: "archived", last_seq: 4 })],
    head_seq: 4,
  });
  assert.deepEqual(kept.threads.map((t) => t.id), ["a", "b"]);
});

test("a parent's summary changes when only its child changed", () => {
  const first = applyThreadList(undefined, {}, { threads: [thread("parent"), thread("child")], head_seq: 3 });
  const next = applyThreadList(first, { since_seq: 3 }, {
    threads: [],
    activity: [{ thread_id: "parent", active_agents: 0, active_processes: 0, active_monitors: 0, active_children: 1 }],
    head_seq: 4,
  });
  assert.equal(next.activity.length, 1);
  assert.equal(next.threads, first.threads);
});

test("show more pages one project's older settled rows", () => {
  const first = applyThreadList(undefined, { settled_limit: 2 }, {
    threads: [thread("a"), thread("b"), thread("run", { status: "running" })],
    head_seq: 9,
    omitted: [{ project_id: "p", count: 3 }],
  });
  assert.deepEqual(first.loadedSettled, { p: 2 });
  const params = moreParams(first, "p");
  assert.equal(params.settled_offset, 2);
  const more = applyThreadList(first, params, {
    threads: [thread("c"), thread("d"), thread("e")],
    head_seq: 11,
    omitted: [],
  });
  assert.deepEqual(more.omitted, {});
  assert.equal(more.loadedSettled.p, 5);
  assert.equal(more.headSeq, 9, "a page leaves the cursor alone");
  assert.equal(more.threads.length, 6);
});
