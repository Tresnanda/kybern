import test from "node:test";
import assert from "node:assert/strict";
import {
  findSubagentFor,
  formatElapsed,
  formatTokenCount,
  spokenElapsed,
  stoppableSubagents,
  stripLabel,
  stripSubagents,
  subagentAncestors,
  subagentBarState,
  subagentChildren,
  subagentCounts,
  subagentDepth,
  subagentDetail,
  subagentGroupDefaultOpen,
  subagentGroupSpan,
  subagentGroupTitle,
  subagentRowLabel,
  subagentStatusSegments,
  subagentTokenCount,
  subagentTypeLabel,
  isSubagentThread,
  subagentPhase,
  visibleSubagentThreads,
  withoutSubagents,
} from "../src/subagents.ts";

test("subagent threads are recognised and filtered out of user lists", () => {
  const user = { id: "a" };
  const child = { id: "b", subagent: { task_id: "t", status: "running" } };
  assert.equal(isSubagentThread(child), true);
  assert.equal(isSubagentThread(user), false);
  assert.equal(isSubagentThread(undefined), false);
  assert.deepEqual(withoutSubagents([user, child]), [user]);
  const same = [user];
  assert.equal(withoutSubagents(same), same, "nothing to remove keeps the array identity");
});

test("task states collapse into working, done, failed and stopped", () => {
  const phases = Object.fromEntries(
    ["pending", "running", "waiting", "stopping", "completed", "failed", "stopped", "interrupted"].map((status) => [status, subagentPhase(status)]),
  );
  assert.deepEqual(phases, {
    pending: "working", running: "working", waiting: "working", stopping: "working",
    completed: "done", failed: "failed", stopped: "stopped", interrupted: "stopped",
  });
});

const T0 = Date.parse("2026-10-06T12:00:00Z");
const iso = (offsetSeconds) => new Date(T0 + offsetSeconds * 1000).toISOString();
function child(id, status, extra = {}, thread = {}) {
  return {
    id,
    title: id,
    parent_thread_id: "root",
    status: status === "running" || status === "pending" ? "running" : "idle",
    subagent: { task_id: `task-${id}`, root_thread_id: "root", parent_turn_id: "turn-1", status, started_at: iso(0), ...extra },
    ...thread,
  };
}

test("group status line orders segments and skips zero counts", () => {
  const counts = subagentCounts(["working", "working", "done", "failed", "stopped", "done"]);
  assert.deepEqual(counts, { working: 2, done: 2, failed: 1, stopped: 1 });
  assert.deepEqual(subagentStatusSegments(counts).map((s) => s.text), ["2 working", "2 done", "1 failed", "1 stopped"]);
  assert.deepEqual(subagentStatusSegments(subagentCounts(["done", "done", "done"])).map((s) => s.text), ["3 done"]);
  assert.equal(subagentGroupTitle(3), "3 subagents");
});

test("a group is open while three or fewer work, collapsed once settled unless one failed", () => {
  assert.equal(subagentGroupDefaultOpen(subagentCounts(["working", "working", "working"])), true);
  assert.equal(subagentGroupDefaultOpen(subagentCounts(["working", "working", "working", "working"])), false);
  assert.equal(subagentGroupDefaultOpen(subagentCounts(["working", "done", "done", "done", "done"])), true);
  assert.equal(subagentGroupDefaultOpen(subagentCounts(["done", "done", "stopped"])), false);
  assert.equal(subagentGroupDefaultOpen(subagentCounts(["done", "failed", "done"])), true);
});

test("elapsed text is zero padded and spoken in words", () => {
  assert.equal(formatElapsed(48_000), "48s");
  assert.equal(formatElapsed(64_000), "1m 04s");
  assert.equal(formatElapsed(3_720_000), "1h 02m");
  assert.equal(formatElapsed(-5), "0s");
  assert.equal(spokenElapsed(150_000), "2 minutes 30 seconds");
  assert.equal(spokenElapsed(61_000), "1 minute 1 second");
  assert.equal(spokenElapsed(0), "0 seconds");
});

test("token counts are omitted rather than shown as zero", () => {
  assert.equal(formatTokenCount(0), null);
  assert.equal(formatTokenCount(null), null);
  assert.equal(formatTokenCount(850), "850 tokens");
  assert.equal(formatTokenCount(18_200), "18.2k tokens");
  assert.equal(formatTokenCount(146_000), "146k tokens");
  assert.equal(subagentTokenCount(child("a", "running", { stats: { token_count: 900 } })), 900);
  assert.equal(subagentTokenCount(child("a", "running", { usage: { input_tokens: 10, output_tokens: 5 } })), 15);
  assert.equal(subagentTokenCount(child("a", "running")), null);
});

test("type labels use the display name for Claude's general agent", () => {
  assert.equal(subagentTypeLabel("general-purpose"), "General");
  assert.equal(subagentTypeLabel("Explore"), "Explore");
  assert.equal(subagentTypeLabel("  "), null);
  assert.equal(subagentTypeLabel(undefined), null);
});

test("the detail line is live progress while working and the result once settled", () => {
  assert.deepEqual(subagentDetail(child("a", "running", { progress: "Running vitest on refresh.test.ts", last_tool_name: "Bash" })), { text: "Running vitest on refresh.test.ts", failed: false });
  assert.deepEqual(subagentDetail(child("a", "running", { last_tool_name: "Read" })), { text: "Using Read", failed: false });
  assert.equal(subagentDetail(child("a", "running")), null);
  assert.deepEqual(subagentDetail(child("a", "completed", { result: "Sessions live in IndexedDB" })), { text: "Sessions live in IndexedDB", failed: false });
  assert.deepEqual(subagentDetail(child("a", "failed", { result: "Request timed out\nmore" })), { text: "Request timed out", failed: true });
  assert.deepEqual(subagentDetail(child("a", "failed")), { text: "Failed", failed: true });
});

test("the bar states follow the design copy", () => {
  assert.equal(subagentBarState(child("a", "pending"), 0).label, "Starting");
  assert.equal(subagentBarState(child("a", "running"), 124_000).label, "Working 2m 04s");
  assert.equal(subagentBarState(child("a", "completed"), 221_000).label, "Completed in 3m 41s");
  assert.equal(subagentBarState(child("a", "failed"), 12_000).label, "Failed after 12s");
  assert.equal(subagentBarState(child("a", "interrupted"), 12_000).label, "Stopped after 12s");
  assert.equal(subagentBarState(child("a", "completed"), null).label, "Completed");
});

test("a group's span runs from the first start to the last end and hides when an end is missing", () => {
  const done = (id, start, end) => child(id, "completed", { started_at: iso(start), completed_at: iso(end) });
  assert.deepEqual(subagentGroupSpan([done("a", 0, 30), done("b", 5, 90)]), { startedAt: T0, endedAt: T0 + 90_000 });
  assert.deepEqual(subagentGroupSpan([done("a", 0, 30), child("b", "running", { started_at: iso(10) })]), { startedAt: T0, endedAt: null });
  assert.equal(subagentGroupSpan([done("a", 0, 30), child("b", "completed", { started_at: iso(10) })]), null);
  assert.equal(subagentGroupSpan([]), null);
});

test("launches find their child by task id or tool call id", () => {
  const children = [child("a", "running", { tool_call_id: "call-a" }), child("b", "running")];
  assert.equal(findSubagentFor(children, { toolCallId: "call-a" })?.id, "a");
  assert.equal(findSubagentFor(children, { taskId: "task-b" })?.id, "b");
  assert.equal(findSubagentFor(children, { toolCallId: "nope", taskId: "nope" }), undefined);
  assert.equal(findSubagentFor(children, {}), undefined);
});

test("children are the direct subagents of a thread in launch order", () => {
  const list = [child("late", "running", { started_at: iso(20) }), child("early", "running", { started_at: iso(5) }), child("other", "running", {}, { parent_thread_id: "elsewhere" }), { id: "plain", parent_thread_id: "root" }];
  assert.deepEqual(subagentChildren(list, "root").map((t) => t.id), ["early", "late"]);
});

test("ancestors and depth walk the parent chain", () => {
  const root = { id: "root" };
  const a = child("a", "running");
  const b = child("b", "running", {}, { parent_thread_id: "a" });
  const all = new Map([root, a, b].map((t) => [t.id, t]));
  const byId = (id) => all.get(id);
  assert.deepEqual(subagentAncestors(b, byId).map((t) => t.id), ["root", "a"]);
  assert.equal(subagentDepth(root, byId), 0);
  assert.equal(subagentDepth(a, byId), 1);
  assert.equal(subagentDepth(b, byId), 2);
  const loop = new Map([["x", { id: "x", parent_thread_id: "y" }], ["y", { id: "y", parent_thread_id: "x" }]]);
  assert.deepEqual(subagentAncestors({ id: "z", parent_thread_id: "x" }, (id) => loop.get(id)).map((t) => t.id), ["y", "x"]);
});

test("the sidebar lists working subagents, the viewed one and any that just settled", () => {
  const now = T0 + 100_000;
  const none = new Set();
  const working = child("working", "running");
  const justDone = child("just-done", "completed", { completed_at: new Date(now - 300).toISOString() });
  const longDone = child("long-done", "completed", { completed_at: iso(10) });
  const viewed = child("viewed", "failed", { completed_at: iso(10) });
  const archived = child("gone", "running", {}, { status: "archived" });
  const list = [longDone, viewed, justDone, working, archived];
  const ids = (selectedId, dismissed = none) => visibleSubagentThreads(list, { selectedId, dismissed, now }).map((t) => t.id);
  assert.deepEqual(ids(null), ["just-done", "working"].sort());
  assert.deepEqual(ids("viewed").sort(), ["just-done", "viewed", "working"]);
  assert.deepEqual(ids("viewed", new Set(["viewed", "working"])).sort(), ["just-done"], "a dismissed row stays gone, even while selected");
  assert.deepEqual(ids(null, new Set(["just-done"])), ["working"]);
});

test("a settled parent subagent stays while a nested child still works", () => {
  const now = T0 + 100_000;
  const parent = child("parent", "completed", { completed_at: iso(10) });
  const nested = child("nested", "running", { started_at: iso(5) }, { parent_thread_id: "parent" });
  const rows = visibleSubagentThreads([parent, nested], { selectedId: null, dismissed: new Set(), now });
  assert.deepEqual(rows.map((t) => t.id), ["parent", "nested"]);
});

test("the strip lists this turn's subagents while it runs, then only those still working", () => {
  const a = child("a", "completed", { started_at: iso(1), completed_at: iso(5) });
  const b = child("b", "running", { started_at: iso(2) });
  const c = child("c", "running", { started_at: iso(3), parent_turn_id: "older-turn" });
  const old = child("old", "completed", { started_at: iso(0), parent_turn_id: "older-turn", completed_at: iso(4) });
  const live = stripSubagents([old, c, b, a], { turnRunning: true, turnId: "turn-1" });
  assert.deepEqual(live.rows.map((t) => t.id), ["a", "b", "c"]);
  assert.equal(live.working, 2);
  const after = stripSubagents([old, c, b, a], { turnRunning: false });
  assert.deepEqual(after.rows.map((t) => t.id), ["b", "c"]);
  assert.equal(stripSubagents([a, old], { turnRunning: false }), null);
  assert.equal(stripSubagents([], { turnRunning: true }), null);
  assert.equal(stripLabel(3, 3), "3 subagents working");
  assert.equal(stripLabel(3, 2), "2 of 3 subagents working");
  assert.equal(stripLabel(2, 0), "2 subagents finished");
});

test("stop all only reaches working subagents that can be stopped", () => {
  const rows = [child("a", "running"), child("b", "completed"), child("c", "running", { capabilities: { stop: false, background: false } }), child("d", "running", { capabilities: { stop: true, background: true } })];
  assert.deepEqual(stoppableSubagents(rows).map((t) => t.id), ["a", "d"]);
});

test("row labels name the subagent, its state and the time in words", () => {
  const working = child("Review token refresh", "running", { started_at: iso(0) });
  assert.equal(subagentRowLabel(working, T0 + 150_000), "Open Review token refresh, working, 2 minutes 30 seconds");
  const bg = child("Check callbacks", "running", { backgrounded: true });
  assert.match(subagentRowLabel(bg, T0 + 5000), /in background/);
});
