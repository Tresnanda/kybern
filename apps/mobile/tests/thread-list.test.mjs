import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_FILTER,
  emptyText,
  filterThreads,
  groupByProject,
  moveInOrder,
  orderProjects,
  relativeTime,
  sectionWindow,
  threadAgents,
  threadRows,
} from "../src/state/threadList.ts";

const at = (minutesAgo) => new Date(Date.parse("2026-10-24T12:00:00Z") - minutesAgo * 60000).toISOString();
const thread = (id, extra = {}) => ({
  id,
  project_id: "p1",
  title: id,
  provider: { kind: "claude-code", instance: "default" },
  permission_mode: "supervised",
  status: "idle",
  cwd: "/",
  pinned: false,
  created_at: at(100),
  updated_at: at(10),
  last_seq: 1,
  ...extra,
});
const projects = [
  { id: "p1", name: "kybern", space_id: "s1" },
  { id: "p2", name: "website", space_id: "s2" },
];
const working = (t) => t.status === "running";

test("filterThreads scopes by space, archived, agent and search, pinned first", () => {
  const threads = [
    thread("a", { updated_at: at(5) }),
    thread("b", { pinned: true, updated_at: at(50) }),
    thread("c", { project_id: "p2" }),
    thread("d", { status: "archived" }),
    thread("e", { provider: { kind: "codex", instance: "default" }, status: "running" }),
    thread("child", { delegation: { status: "running" }, parent_thread_id: "a" }),
  ];
  const ids = (filter, spaceId = "s1") =>
    filterThreads({ threads, projects, spaceId, filter: { ...DEFAULT_FILTER, ...filter }, isWorking: working }).map((t) => t.id);
  assert.deepEqual(ids({}), ["b", "a", "e"]);
  assert.deepEqual(ids({}, null), ["b", "a", "c", "e"]);
  assert.deepEqual(ids({ archived: true }), ["d"]);
  assert.deepEqual(ids({ scope: "working" }), ["e"]);
  assert.deepEqual(ids({ scope: "pinned" }), ["b"]);
  assert.deepEqual(ids({ agent: "codex" }), ["e"]);
  assert.deepEqual(ids({ query: "KYB" }), ["b", "a", "e"]);
  assert.deepEqual(ids({ query: "codex" }), ["e"]);
});

test("threadRows nests working children under shown parents and opens them", () => {
  const now = Date.parse("2026-10-24T12:00:00Z");
  const top = [thread("a"), thread("b")];
  const children = [
    thread("c1", { parent_thread_id: "a", delegation: { status: "running", started_at: at(3) } }),
    thread("c2", { parent_thread_id: "a", delegation: { status: "completed", started_at: at(30), completed_at: at(20) } }),
    thread("orphan", { parent_thread_id: "zzz", delegation: { status: "running", started_at: at(3) } }),
  ];
  const rows = threadRows(top, children, {}, { now });
  assert.deepEqual(rows.map((r) => [r.thread.id, r.depth, r.child]), [["a", 0, false], ["c1", 1, true], ["b", 0, false]]);
  assert.equal(rows[0].open, true);
  assert.equal(rows[0].childCount, 1);
  const closed = threadRows(top, children, { a: false }, { now });
  assert.deepEqual(closed.map((r) => r.thread.id), ["a", "b"]);
});

test("project order: chosen first, then most recent; move swaps neighbours", () => {
  const list = [{ id: "x", name: "x" }, { id: "y", name: "y" }, { id: "z", name: "z" }];
  assert.deepEqual(orderProjects(list, ["z"], { x: at(50), y: at(5) }).map((p) => p.id), ["z", "y", "x"]);
  assert.deepEqual(moveInOrder(["x", "y", "z"], "z", -1), ["x", "z", "y"]);
  assert.deepEqual(moveInOrder(["x", "y", "z"], "x", -1), ["x", "y", "z"]);
});

test("groupByProject keeps free chats last", () => {
  const groups = groupByProject(
    [thread("a"), thread("f", { project_id: "00000000-0000-0000-0000-000000000001" }), thread("w", { project_id: "p2", updated_at: at(1) })],
    projects,
    [],
  );
  assert.deepEqual(groups.map((g) => g.name), ["website", "kybern", "Free chats"]);
});

test("agents, empty copy and relative time", () => {
  assert.deepEqual(threadAgents([thread("a"), thread("b", { provider: { kind: "codex" } })], "pi"), ["claude-code", "codex", "pi"]);
  assert.equal(emptyText({ ...DEFAULT_FILTER, scope: "pinned" }, "Codex").title, "No pinned Codex threads");
  assert.equal(emptyText({ ...DEFAULT_FILTER, query: " zz " }).title, "No threads match “zz”");
  const now = Date.parse("2026-10-24T12:00:00Z");
  assert.equal(relativeTime(at(0.5), now), "Now");
  assert.equal(relativeTime(at(90), now), "1h");
  assert.equal(relativeTime(at(60 * 24 * 15), now), "2w");
});

test("sections page: ten first, twenty more per tap, never past the total", () => {
  assert.deepEqual(sectionWindow(91, 0), { shown: 10, remaining: 81 });
  assert.deepEqual(sectionWindow(91, 1), { shown: 30, remaining: 61 });
  assert.deepEqual(sectionWindow(91, 4), { shown: 90, remaining: 1 });
  assert.deepEqual(sectionWindow(91, 5), { shown: 91, remaining: 0 });
  assert.deepEqual(sectionWindow(4, 0), { shown: 4, remaining: 0 });
  assert.deepEqual(sectionWindow(0, 2), { shown: 0, remaining: 0 });
  assert.deepEqual(sectionWindow(100, 0, 30), { shown: 30, remaining: 70 });
});
