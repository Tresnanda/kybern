import test from "node:test";
import assert from "node:assert/strict";
import { messageStateWord, threadByOperation } from "../src/delegations.ts";
import {
  EMPTY_MESSAGE_INDEX,
  liveSend,
  mergeMessages,
  messageOf,
  replyOf,
  resolveMessage,
  setThreadIndex,
  unseedAll,
} from "../src/messageStates.ts";
import { parseSendResult } from "../src/orchestrationTools.ts";

const T0 = Date.parse("2026-10-06T10:00:00Z");
const iso = (seconds) => new Date(T0 + seconds * 1000).toISOString();

function record(id, state, seconds, extra = {}) {
  return { id, operation_id: `op-${id}`, from_thread_id: "a", to_thread_id: "b", purpose: "message", body: `body ${id}`, delivery: "queue", state, created_at: iso(seconds), updated_at: iso(seconds), ...extra };
}

const sent = (state, extra = {}) => parseSendResult({ content: [{ type: "text", text: JSON.stringify({ message_id: "m1", state, delivered_as: state, ...extra }) }] });

test("state words cover every message state", () => {
  assert.deepEqual(
    ["queued", "steered", "delivered", "held", "dismissed", "answered", "failed"].map(messageStateWord),
    ["Queued", "Sent now", "Delivered", "Held for approval", "Dismissed", "Answered", "Not delivered"],
  );
});

test("merging a newer record replaces the older one and keeps identity when nothing changed", () => {
  const first = mergeMessages(undefined, [record("m1", "held", 0)]);
  assert.equal(messageOf(first, "m1").state, "held");
  const second = mergeMessages(first, [record("m1", "queued", 5)]);
  assert.equal(messageOf(second, "m1").state, "queued");
  // The same record again, and an older one, leave the index untouched.
  assert.equal(mergeMessages(second, [record("m1", "queued", 5)]), second);
  assert.equal(mergeMessages(second, [record("m1", "held", 0)]), second);
});

test("a listing never overrides an event it raced with, but an event does at equal times", () => {
  const live = mergeMessages(undefined, [record("m1", "answered", 9)]);
  assert.equal(mergeMessages(live, [record("m1", "queued", 9)], { fromListing: true }).byId.m1.state, "answered");
  assert.equal(mergeMessages(live, [record("m1", "dismissed", 9)]).byId.m1.state, "dismissed");
});

test("seeding marks the index even when the listing is empty", () => {
  const seeded = mergeMessages(undefined, [], { fromListing: true });
  assert.equal(seeded.seeded, true);
  assert.equal(mergeMessages(seeded, [], { fromListing: true }), seeded);
  assert.equal(mergeMessages(undefined, [record("m1", "queued", 0)]).seeded, false);
});

test("replies are found by the question they answer", () => {
  const index = mergeMessages(undefined, [record("m1", "answered", 0), record("m1r", "delivered", 3, { from_thread_id: "b", to_thread_id: "a", purpose: "reply", reply_to: "m1" })]);
  assert.equal(replyOf(index, "m1").id, "m1r");
  assert.equal(replyOf(index, "m1r"), undefined);
  assert.equal(replyOf(index, null), undefined);
  assert.equal(replyOf(undefined, "m1"), undefined);
});

test("the record store is bounded and drops the oldest first, keeping the newest insert", () => {
  let index = EMPTY_MESSAGE_INDEX;
  for (let i = 0; i < 6; i++) index = mergeMessages(index, [record(`m${i}`, "queued", i)], { limit: 4 });
  assert.deepEqual(Object.keys(index.byId).sort(), ["m2", "m3", "m4", "m5"]);
  // A late record older than everything is still kept when it is the one just inserted.
  index = mergeMessages(index, [record("old", "queued", -10)], { limit: 4 });
  assert.ok(index.byId.old);
  assert.equal(Object.keys(index.byId).length, 4);
  // Evicted replies leave the reply index too.
  let replies = mergeMessages(undefined, [record("q", "answered", 0), record("r", "delivered", 1, { reply_to: "q" })], { limit: 2 });
  assert.equal(replies.replies.q, "r");
  replies = mergeMessages(replies, [record("x", "queued", 2), record("y", "queued", 3)], { limit: 2 });
  assert.equal(replies.replies.q, undefined);
});

test("resolving a held message moves only a held record", () => {
  const index = mergeMessages(undefined, [record("m1", "held", 0, { held_reason: "broader permissions" }), record("m2", "answered", 0)]);
  const delivered = resolveMessage(index, "m1", "delivered");
  assert.equal(delivered.byId.m1.state, "delivered");
  assert.equal(delivered.byId.m1.held_reason, null);
  assert.equal(resolveMessage(index, "m1", "dismissed").byId.m1.state, "dismissed");
  assert.equal(resolveMessage(index, "m2", "dismissed"), index);
  assert.equal(resolveMessage(index, "missing", "delivered"), index);
  assert.equal(resolveMessage(undefined, "m1", "delivered"), undefined);
  // A later event still wins over the local resolution.
  const later = mergeMessages(delivered, [record("m1", "queued", 4)]);
  assert.equal(later.byId.m1.state, "queued");
});

test("the thread table keeps the most recent threads and never evicts the open ones", () => {
  const one = mergeMessages(undefined, [record("m1", "queued", 0)]);
  let all = {};
  for (const id of ["t1", "t2", "t3"]) all = setThreadIndex(all, id, one, () => false, 3);
  all = setThreadIndex(all, "t4", one, () => false, 3);
  assert.deepEqual(Object.keys(all), ["t2", "t3", "t4"]);
  // Touching a thread moves it to the back; a protected thread is skipped.
  all = setThreadIndex(all, "t2", mergeMessages(one, [record("m2", "queued", 1)]), (id) => id === "t3", 3);
  all = setThreadIndex(all, "t5", one, (id) => id === "t3", 3);
  assert.deepEqual(Object.keys(all), ["t3", "t2", "t5"]);
});

test("a dropped connection unseeds every thread and leaves unseeded ones alone", () => {
  const seeded = mergeMessages(undefined, [], { fromListing: true });
  const plain = mergeMessages(undefined, [record("m1", "queued", 0)]);
  const all = { a: seeded, b: plain };
  const next = unseedAll(all);
  assert.equal(next.a.seeded, false);
  assert.equal(next.b, plain);
  assert.equal(unseedAll(next), next);
});

test("a sent row follows its record: held, then delivered, then answered", () => {
  const result = sent("held");
  assert.deepEqual({ ...liveSend(result, undefined, undefined, true, false), reply: null }, { state: "held", word: "Held for approval", reply: null, held: true });
  const resolved = liveSend(result, record("m1", "delivered", 5), undefined, true, false);
  assert.equal(resolved.word, "Delivered");
  assert.equal(resolved.held, false);
  const dismissed = liveSend(result, record("m1", "dismissed", 5), undefined, true, false);
  assert.deepEqual({ state: dismissed.state, word: dismissed.word, held: dismissed.held }, { state: "dismissed", word: "Dismissed", held: false });
  const reply = record("m1r", "delivered", 8, { from_thread_id: "b", to_thread_id: "a", purpose: "reply", reply_to: "m1", body: "Yes, on blur." });
  const answered = liveSend(sent("queued"), record("m1", "answered", 8), reply, true, false);
  assert.equal(answered.state, "answered");
  assert.equal(answered.word, "Answered");
  assert.deepEqual(answered.reply, { messageId: "m1r", fromThreadId: "b", body: "Yes, on blur." });
});

test("a sent row without a record keeps what the tool said, and errors and pending calls win", () => {
  assert.equal(liveSend(sent("steered"), undefined, undefined, true, false).word, "Sent now");
  assert.equal(liveSend(sent("queued", { reply: { message_id: "r", from_thread_id: "b", body: "ok" } }), undefined, undefined, true, false).word, "Answered");
  assert.equal(liveSend(null, undefined, undefined, true, false).word, "Sent");
  assert.equal(liveSend(null, undefined, undefined, false, false).word, "Sending");
  assert.equal(liveSend(sent("queued"), record("m1", "held", 0), undefined, true, true).word, "Not sent");
  assert.equal(liveSend(sent("answered"), undefined, undefined, true, false).word, "Answered");
  // A failed delivery is not covered up by an earlier reply.
  assert.equal(liveSend(sent("queued"), record("m1", "failed", 3), undefined, true, false).word, "Not delivered");
});

test("a child is found by its operation through one index per thread table", () => {
  const threads = { a: { id: "a", delegation: { operation_id: "op-1" } }, b: { id: "b" }, c: { id: "c", delegation: { operation_id: "op-2" } } };
  assert.equal(threadByOperation(threads, "op-2").id, "c");
  assert.equal(threadByOperation(threads, "op-9"), undefined);
  // A new table is a new index; the old one is not mutated.
  const next = { ...threads, d: { id: "d", delegation: { operation_id: "op-9" } } };
  assert.equal(threadByOperation(next, "op-9").id, "d");
  assert.equal(threadByOperation(threads, "op-9"), undefined);
});
