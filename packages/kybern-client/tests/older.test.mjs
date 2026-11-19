import assert from "node:assert/strict";
import test from "node:test";
import { OLDER_AFTER_CHOICES, inOlder, olderAfter, splitOlder } from "../src/older.ts";

const thread = (id, extra = {}) => ({ id, status: "idle", pinned: false, last_seq: 10, updated_at: "2026-10-24T10:00:00Z", ...extra });
const older = (id, extra = {}) => thread(id, { older_at: "2026-11-01T00:00:00Z", ...extra });

test("only threads the daemon moved go to Older", () => {
  assert.equal(inOlder(thread("a")), false);
  assert.equal(inOlder(older("a")), true);
  assert.equal(inOlder(older("a", { status: "failed" }), { attentionDismissals: { a: 10 } }), true, "a failure waved off");
});

test("a thread that asks for the reader stays in the main list until it is dealt with", () => {
  assert.equal(inOlder(older("a"), { unread: { a: true } }), false, "unread");
  assert.equal(inOlder(older("a", { status: "failed" })), false, "a failure not yet seen");
  assert.equal(inOlder(older("a"), { pending: { a: { child: "question" } } }), false, "a delegated agent waits");
  assert.equal(inOlder(older("a", { status: "running" })), false);
  assert.equal(inOlder(older("a", { status: "awaiting-approval" })), false);
});

test("pinned and opted-out threads never show in Older, even on a stale row", () => {
  assert.equal(inOlder(older("a", { pinned: true })), false);
  assert.equal(inOlder(older("a", { keep_out_of_older: true })), false);
});

test("splitting keeps each group in the order given", () => {
  const rows = [thread("a"), older("b"), thread("c"), older("d"), older("e")];
  const { recent, older: group } = splitOlder(rows, { unread: { e: true } });
  assert.deepEqual(recent.map((t) => t.id), ["a", "c", "e"]);
  assert.deepEqual(group.map((t) => t.id), ["b", "d"]);
  assert.deepEqual(splitOlder([]), { recent: [], older: [] });
});

test("the setting defaults to 7 days and offers four choices", () => {
  assert.equal(olderAfter(null), "seven_days");
  assert.equal(olderAfter({}), "seven_days");
  assert.equal(olderAfter({ older_after: "never" }), "never");
  assert.deepEqual(OLDER_AFTER_CHOICES.map((c) => c.label), ["Never", "3 days", "7 days", "30 days"]);
});
