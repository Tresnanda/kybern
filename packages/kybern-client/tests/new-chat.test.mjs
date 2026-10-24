import test from "node:test";
import assert from "node:assert/strict";
import { createNewChats, mergeOptimisticThreads, optimisticThread, titleFromMessage, uuidv7 } from "../src/newChat.ts";

const text = (value) => ({ parts: [{ type: "text", text: value }] });
const thread = (id, extra = {}) => optimisticThread({
  id, projectId: "p", provider: { kind: "codex", instance: "default" }, permissionMode: "supervised", message: text("Fix the login flow\nand more"), ...extra,
});

test("uuidv7 puts the time first and sets the version and variant", () => {
  const id = uuidv7(0x0190_1234_5678, (bytes) => bytes.fill(0xff));
  assert.equal(id, "01901234-5678-7fff-bfff-ffffffffffff");
  assert.match(uuidv7(), /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(uuidv7(1000) < uuidv7(2000), "later ids sort later");
});

test("the optimistic thread reads like the daemon's: its title is the first line, it is running", () => {
  const record = thread("t1");
  assert.equal(record.title, "Fix the login flow");
  assert.equal(record.status, "running");
  assert.equal(titleFromMessage(text("x".repeat(61))), `${"x".repeat(60)}…`);
  assert.equal(titleFromMessage(text("  \n ")), "New thread");
});

test("merging keeps unlisted threads after the pinned ones and reports the listed", () => {
  const server = [{ ...thread("pinned"), pinned: true, created_at: "2026-01-01T00:00:00Z" }, { ...thread("old"), created_at: "2026-01-02T00:00:00Z" }];
  const fresh = { ...thread("new"), created_at: "2026-10-24T00:00:00Z" };
  const { threads, listed } = mergeOptimisticThreads(server, [fresh, server[1]]);
  assert.deepEqual(threads.map((t) => t.id), ["pinned", "new", "old"]);
  assert.deepEqual(listed, ["old"]);
});

test("a failed create keeps the thread and its ids; retry repeats it, an edit brings its own message id", async () => {
  const calls = [];
  let fail = true;
  const chats = createNewChats();
  const create = async (message, messageId) => { calls.push([message.parts[0].text, messageId]); if (fail) throw new Error("bad base branch"); };
  const failed = await chats.start({ threadId: "t1", messageId: "m1", message: text("hi"), worktree: true, thread: thread("t1") }, create);
  assert.equal(failed.state, "failed");
  assert.equal(failed.error, "bad base branch");
  assert.equal(chats.get("t1").thread.status, "failed");
  assert.ok(chats.uncreated("t1"));
  assert.deepEqual(chats.unlisted().map((t) => t.id), ["t1"]);

  fail = false;
  const edited = await chats.retry("t1", { message: text("hello"), messageId: "m2" });
  assert.equal(edited.state, "created");
  assert.deepEqual(calls, [["hi", "m1"], ["hello", "m2"]]);
  assert.ok(!chats.uncreated("t1"));
  chats.listed(["t1"]);
  assert.equal(chats.get("t1"), undefined, "the daemon's copy takes over");
});

test("a repeat while the first create runs joins it", async () => {
  let release;
  const chats = createNewChats();
  const first = chats.start({ threadId: "t1", messageId: "m1", message: text("hi"), worktree: false, thread: thread("t1") }, () => new Promise((resolve) => { release = resolve; }));
  assert.equal(chats.retry("t1"), chats.get("t1") && chats.retry("t1"));
  release();
  assert.equal((await first).state, "created");
});
