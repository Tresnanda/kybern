import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
registerHooks({ resolve(specifier, context, next) {
  const url = specifier.startsWith(".") && context.parentURL ? new URL(specifier, context.parentURL) : null;
  if (url?.protocol === "file:" && !/\.[a-z]+$/i.test(url.pathname) && existsSync(fileURLToPath(url) + ".ts")) return { shortCircuit: true, url: url.href + ".ts" };
  return next(specifier, context);
} });
const { mergeChildren, remoteChildrenOf } = await import("../src/machines/remoteChildren.ts");
const { threadParentKey } = await import("../../../packages/kybern-client/src/machineMerge.ts");

const thread = (id, extra = {}) => ({ id, project_id: "p", title: id, status: "idle", pinned: false, last_seq: 1, created_at: `2026-11-01T00:00:0${id.length}Z`, updated_at: "2026-11-01T00:00:00Z", ...extra });
// A delegated child a thread on machine "mac" started on machine "pc": no parent there, an origin naming the parent.
const delegated = (id, parent, machine = "mac", extra = {}) =>
  thread(id, { delegation: { role: "worker" }, origin: { machine_id: machine, thread_id: parent }, ...extra });
const listed = (machineId, t) => ({ machineId, thread: t, parentKey: threadParentKey(machineId, t) });

test("children another machine started appear under their parent, with their own machine's copy", () => {
  const child = delegated("c1", "parent");
  const entries = [listed("pc", child), listed("pc", delegated("c2", "other-parent")), listed("pc", thread("plain")), listed("mac", thread("parent"))];
  const children = remoteChildrenOf(entries, "mac", "parent");
  assert.deepEqual(children.map((t) => t.id), ["c1"]);
  assert.equal(children[0].parent_thread_id, "parent", "listed under the thread that started it");
  assert.equal(child.parent_thread_id, undefined, "the source copy is untouched");
  assert.equal(remoteChildrenOf(entries, "mac", "parent")[0], children[0], "an unchanged child keeps its identity");
});

test("a parent with the same id on another machine gets none", () => {
  const entries = [listed("pc", delegated("c1", "parent", "mac"))];
  assert.deepEqual(remoteChildrenOf(entries, "pc", "parent"), []);
});

test("archived children and subagents are not remote children", () => {
  const entries = [
    listed("pc", delegated("c1", "parent", "mac", { status: "archived" })),
    listed("pc", thread("s1", { subagent: { agent_type: "x" }, origin: { machine_id: "mac", thread_id: "parent" } })),
  ];
  assert.deepEqual(remoteChildrenOf(entries, "mac", "parent"), []);
});

test("merging keeps one copy of each child, newest first-created order, and the newer copy", () => {
  const own = [thread("a", { created_at: "2026-11-01T00:00:02Z" }), thread("b", { created_at: "2026-11-01T00:00:04Z", last_seq: 1 })];
  const remote = [thread("b", { created_at: "2026-11-01T00:00:04Z", last_seq: 5 }), thread("c", { created_at: "2026-11-01T00:00:03Z" })];
  const merged = mergeChildren(own, remote);
  assert.deepEqual(merged.map((t) => t.id), ["a", "c", "b"]);
  assert.equal(merged[2].last_seq, 5);
  assert.equal(mergeChildren(own, []), own, "nothing remote leaves the list alone");
});
