import assert from "node:assert/strict";
import test from "node:test";
import {
  applyEvent,
  prependHistory,
  retainHistoryIdentities,
  seedFromGet,
} from "../src/state/transcript.ts";

const at = "2026-09-09T00:00:00Z";
const assistant = (
  id,
  seq,
  text,
  complete = true,
  origin = { kind: "root" },
) => ({
  role: "assistant",
  id,
  seq,
  text,
  complete,
  origin,
  turn_id: "turn",
  at,
});
const snapshot = (transcript, lastSeq = 30, cursor = null) => ({
  thread: { id: "thread", last_seq: lastSeq, status: "running" },
  transcript,
  pending_approvals: [],
  next_before_seq: cursor,
});
const event = (seq, payload) => ({
  thread_id: "thread",
  turn_id: "turn",
  at,
  seq,
  ...payload,
});

test("history prepends retain settled identities, newest metadata and an older cursor", () => {
  const base = seedFromGet(
    snapshot([assistant("latest", 20, "Latest")], 30, 20),
  );
  const page = snapshot(
    [assistant("old", 1, "Earlier"), assistant("latest", 20, "Latest")],
    30,
    1,
  );
  const next = prependHistory(base, page);
  assert.deepEqual(
    next.blocks.map((b) => b.id),
    ["old#0", "latest#0"],
  );
  assert.equal(next.blocks[1], base.blocks[0]);
  assert.equal(next.lastSeq, 30);
  assert.equal(next.nextBeforeSeq, 1);
  assert.equal(next.loadingEarlier, false);
});

test("a page request replays in-flight text once and retains the already rendered tail", () => {
  const base = seedFromGet(
    snapshot([assistant("latest", 20, "Hello", false)], 30, 20),
  );
  const delta = event(31, {
    kind: "assistant_text_delta",
    message_id: "latest",
    origin: { kind: "root" },
    delta: " world",
  });
  const live = applyEvent(base, delta);
  const combined = prependHistory(
    base,
    snapshot([assistant("old", 1, "Earlier")], 30),
    [delta],
  );
  const next = retainHistoryIdentities(combined, live);
  assert.equal(
    next.blocks.find((b) => b.id === "latest#0").text,
    "Hello world",
  );
  assert.equal(
    next.blocks.find((b) => b.id === "latest#0"),
    live.blocks[0],
  );
  assert.equal(next.lastSeq, 31);
});

test("loading a previously unseen beginning repairs a partial live row without duplicating it", () => {
  let base = seedFromGet(snapshot([], 30, 20));
  base = applyEvent(
    base,
    event(31, {
      kind: "assistant_text_delta",
      message_id: "old",
      origin: { kind: "root" },
      delta: " tail",
    }),
  );
  const page = snapshot(
    [assistant("old", 1, "Earlier beginning tail", false)],
    31,
  );
  const next = retainHistoryIdentities(prependHistory(base, page), base);
  assert.equal(next.blocks.length, 1);
  assert.equal(next.blocks[0].text, "Earlier beginning tail");
  assert.equal(next.blocks[0].seq, 1);
});

test("tool completion while an older agent page loads stays in the agent transcript", () => {
  const base = seedFromGet(snapshot([assistant("latest", 20, "Root")], 30, 20));
  const page = snapshot(
    [
      {
        role: "tool_call",
        seq: 1,
        turn_id: "turn",
        at,
        origin: { kind: "agent", task_id: "child" },
        call: { id: "tool", name: "Read", input: {} },
        complete: false,
        is_error: false,
      },
    ],
    30,
  );
  const completion = event(31, {
    kind: "tool_call_completed",
    tool_call_id: "tool",
    output: "Exact final output",
    is_error: false,
  });
  const next = prependHistory(base, page, [completion]);
  assert.equal(next.blocks.length, 1);
  assert.equal(next.taskActivity.child[0].output, "Exact final output");
  assert.equal(next.taskActivity.child[0].complete, true);
});

test("old daemons without paging metadata retain the entire history", () => {
  const response = snapshot(
    Array.from({ length: 1000 }, (_, i) =>
      assistant(`a${i}`, i + 1, `Text ${i}`),
    ),
    1000,
  );
  delete response.next_before_seq;
  const next = seedFromGet(response);
  assert.equal(next.blocks.length, 1000);
  assert.equal(next.nextBeforeSeq, null);
});
