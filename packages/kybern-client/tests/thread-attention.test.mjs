import assert from "node:assert/strict";
import test from "node:test";
import { ATTENTION_RANK, attentionItems, attentionKind, pendingBadge, pendingOf, threadAttention } from "../src/threadAttention.ts";

const thread = (id, extra = {}) => ({ id, status: "idle", last_seq: 10, updated_at: "2026-10-24T10:00:00Z", ...extra });

test("a waiting request names what it asks for, its own before a delegate's", () => {
  assert.equal(pendingBadge("awaiting-approval", { own: "question" }), "Needs input");
  assert.equal(pendingBadge("awaiting-approval", { own: "approval" }), "Pending approval");
  assert.equal(pendingBadge("awaiting-approval", undefined), "Pending");
  assert.equal(pendingBadge("awaiting-approval", { child: "question" }), "Pending");
  assert.equal(pendingBadge("running", { child: "question" }), "Needs input");
  assert.equal(pendingBadge("idle", { child: "approval" }), "Pending approval");
  assert.equal(pendingBadge("running", undefined), null);
});

test("pendingOf folds an activity summary and returns null when nothing waits", () => {
  assert.equal(pendingOf({}), null);
  assert.equal(pendingOf({ pending_request: null, pending_child_request: null }), null);
  assert.deepEqual(pendingOf({ pending_request: "approval" }), { own: "approval" });
  assert.deepEqual(pendingOf({ pending_request: "question", pending_child_request: "approval" }), { own: "question", child: "approval" });
});

test("a pending approval, a delegated agent's wait, a failure and an unseen finish are the four reasons", () => {
  assert.equal(attentionKind(thread("a", { status: "awaiting-approval" }), {}), "blocked");
  assert.equal(attentionKind(thread("a", { status: "running" }), { pending: { a: { child: "question" } } }), "blocked");
  assert.equal(attentionKind(thread("a", { status: "failed" }), {}), "failed");
  assert.equal(attentionKind(thread("a"), { unread: { a: true } }), "done");
  assert.equal(attentionKind(thread("a"), {}), null);
  assert.equal(attentionKind(thread("a", { status: "running" }), { unread: { a: true } }), null);
});

test("children, subagents and archived threads never ask for attention", () => {
  const signals = { unread: { a: true } };
  assert.equal(attentionKind(thread("a", { status: "failed", parent_thread_id: "p" }), signals), null);
  assert.equal(attentionKind(thread("a", { status: "failed", subagent: { parent_thread_id: "p" } }), signals), null);
  assert.equal(attentionKind(thread("a", { status: "archived" }), signals), null);
});

test("a dismissal hides blocked and failed until the thread moves on, never a finished turn", () => {
  const failed = thread("a", { status: "failed", last_seq: 10 });
  assert.equal(attentionKind(failed, { attentionDismissals: { a: 10 } }), null);
  assert.equal(attentionKind(failed, { attentionDismissals: { a: 9 } }), "failed");
  assert.equal(attentionKind(thread("a"), { unread: { a: true }, attentionDismissals: { a: 99 } }), "done");
});

test("threadAttention bundles the dot, the badge and the unread mark for a row", () => {
  const signals = { unread: { a: true }, pending: { a: { own: "question" } } };
  assert.deepEqual(threadAttention(thread("a", { status: "awaiting-approval" }), signals), { kind: "blocked", badge: "Needs input", unread: true });
  assert.deepEqual(threadAttention(thread("b"), signals), { kind: null, badge: null, unread: false });
  assert.deepEqual(threadAttention(thread("a"), { unread: { a: true } }), { kind: "done", badge: null, unread: true });
  assert.deepEqual(threadAttention(thread("a", { status: "archived" }), { unread: { a: true } }), { kind: null, badge: null, unread: false });
});

test("the most urgent come first, then the newest", () => {
  const threads = [
    thread("done", { updated_at: "2026-10-24T12:00:00Z" }),
    thread("old-failed", { status: "failed", updated_at: "2026-10-24T08:00:00Z" }),
    thread("new-failed", { status: "failed", updated_at: "2026-10-24T09:00:00Z" }),
    thread("blocked", { status: "awaiting-approval", updated_at: "2026-10-24T01:00:00Z" }),
    thread("quiet"),
  ];
  const items = attentionItems(threads, { unread: { done: true } });
  assert.deepEqual(items.map((item) => `${item.thread.id}:${item.kind}`), ["blocked:blocked", "new-failed:failed", "old-failed:failed", "done:done"]);
  assert.ok(ATTENTION_RANK.blocked < ATTENTION_RANK.failed && ATTENTION_RANK.failed < ATTENTION_RANK.done);
});
