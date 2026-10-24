import test from "node:test";
import assert from "node:assert/strict";
import { clientThreadIds, createNewChats, mergeIntoCurrent, mergeOptimisticThreads, optimisticThread, titleFromMessage, uuidv7, versionAtLeast } from "../src/newChat.ts";

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

test("only daemons from 0.15.0 take the client's thread ids", () => {
  assert.ok(clientThreadIds("0.15.0"));
  assert.ok(clientThreadIds("v0.16.2"));
  assert.ok(clientThreadIds("1.0.0"));
  assert.ok(!clientThreadIds("0.14.9"));
  assert.ok(!clientThreadIds(null));
  assert.ok(versionAtLeast("0.15.0-dev", "0.15.0"));
});

test("a create answered under another id is adopted: no ghost row, and the page can follow", async () => {
  const adopted = [];
  const chats = createNewChats({ onAdopt: (from, to) => adopted.push([from, to]) });
  const done = await chats.start({ threadId: "t1", messageId: "m1", message: text("hi"), worktree: false, thread: thread("t1") }, async () => ({ ...thread("server"), cwd: "/x" }));
  assert.equal(done.state, "created");
  assert.equal(done.adoptedId, "server");
  assert.deepEqual(adopted, [["t1", "server"]]);
  assert.deepEqual(chats.unlisted(), [], "the daemon's own row is the only one");
  assert.ok(!chats.uncreated("t1"));
  chats.listed(["server"]);
  assert.equal(chats.get("t1"), undefined);
  const same = await chats.start({ threadId: "t2", messageId: "m2", message: text("hi"), worktree: false, thread: thread("t2") }, async () => "t2");
  assert.equal(same.adoptedId, undefined);
});

test("every change is a new record, so external-store snapshots re-render", async () => {
  let fail = true;
  const chats = createNewChats();
  const pending = chats.start({ threadId: "t1", messageId: "m1", message: text("hi"), worktree: true, thread: thread("t1") }, async () => { if (fail) throw new Error("no"); });
  const creating = chats.get("t1");
  await pending;
  const failed = chats.get("t1");
  assert.notEqual(failed, creating);
  assert.equal(creating.state, "creating", "an earlier snapshot never changes under a reader");
  fail = false;
  const retry = chats.retry("t1");
  assert.notEqual(chats.get("t1"), failed);
  assert.equal(failed.state, "failed");
  await retry;
  assert.equal(chats.get("t1").state, "created");
});

test("a create that failed here but reached the daemon is dropped once the daemon lists it", async () => {
  const chats = createNewChats();
  await chats.start({ threadId: "t1", messageId: "m1", message: text("hi"), worktree: false, thread: thread("t1") }, async () => { throw new Error("socket closed"); });
  assert.equal(chats.get("t1").state, "failed");
  chats.listed(["t1"]);
  assert.equal(chats.get("t1"), undefined, "the daemon's thread loads like any other");
});

test("merging into the current list keeps live changes and the daemon's copy of a new thread", () => {
  const seen = new WeakSet();
  const loaded = [{ ...thread("a"), status: "running" }, { ...thread("b"), status: "idle" }];
  const fresh = thread("new");
  let current = mergeIntoCurrent(loaded, [fresh], seen).threads;
  // Live events since the last full load: a finished, b archived (dropped from the list).
  current = current.filter((t) => t.id !== "b").map((t) => (t.id === "a" ? { ...t, status: "idle" } : t));
  const failed = { ...fresh, status: "failed" };
  const next = mergeIntoCurrent(current, [failed], seen).threads;
  assert.deepEqual(next.map((t) => [t.id, t.status]), [["new", "failed"], ["a", "idle"]], "no archived row comes back, no status reverts, no stale copy");
  const server = { ...fresh, cwd: "/repo", status: "idle" };
  const settled = mergeIntoCurrent([server, ...next.filter((t) => t.id !== "new")], [failed], seen);
  assert.equal(settled.threads.find((t) => t.id === "new"), server, "the daemon's copy wins");
  assert.deepEqual(settled.listed, ["new"]);
});
