import assert from "node:assert/strict"
import test from "node:test"

import {
  DEFAULT_SIDEBAR_FILTER,
  dropIndex,
  isFiltering,
  moveProject,
  orderProjects,
  readSidebarFilter,
  threadMatchesFilter,
} from "./src/state/sidebarOrganize.ts"

const project = (id, name) => ({ id, name })
const thread = (overrides = {}) => ({ status: "idle", pinned: false, provider: { kind: "claude-code", instance: "default" }, ...overrides })

test("projects follow the saved order and newer projects follow alphabetically", () => {
  const projects = [project("w", "website"), project("k", "kybern"), project("m", "mobile"), project("a", "api")]
  assert.deepEqual(orderProjects(projects, []).map((p) => p.id), ["a", "k", "m", "w"])
  assert.deepEqual(orderProjects(projects, ["m", "w", "removed"]).map((p) => p.id), ["m", "w", "a", "k"])
})

test("moving a project places it among the visible projects", () => {
  const order = ["a", "b", "c", "d"]
  assert.deepEqual(moveProject(order, order, "d", 0), ["d", "a", "b", "c"])
  assert.deepEqual(moveProject(order, order, "a", 3), ["b", "c", "d", "a"])
  assert.deepEqual(moveProject(order, order, "b", 1), order)
})

test("moving a project while others are filtered out keeps hidden projects in place", () => {
  const order = ["a", "hidden1", "b", "hidden2", "c"]
  const visible = ["a", "b", "c"]
  assert.deepEqual(moveProject(order, visible, "c", 0), ["c", "a", "hidden1", "b", "hidden2"])
  assert.deepEqual(moveProject(order, visible, "a", 2), ["hidden1", "b", "hidden2", "c", "a"])
  assert.deepEqual(moveProject(order, visible, "a", 1), ["hidden1", "b", "hidden2", "a", "c"])
})

test("a dragged row drops past every row whose midpoint it crossed", () => {
  const midpoints = [10, 50, 90]
  assert.equal(dropIndex(midpoints, 0), 0)
  assert.equal(dropIndex(midpoints, 49), 1)
  assert.equal(dropIndex(midpoints, 51), 2)
  assert.equal(dropIndex(midpoints, 200), 3)
})

test("filters match pinned threads, working threads, and one agent", () => {
  const pinned = { threads: "pinned", agent: null }
  const working = { threads: "working", agent: null }
  assert.equal(threadMatchesFilter(thread(), DEFAULT_SIDEBAR_FILTER), true)
  assert.equal(threadMatchesFilter(thread({ pinned: true }), pinned), true)
  assert.equal(threadMatchesFilter(thread(), pinned), false)
  assert.equal(threadMatchesFilter(thread({ status: "running" }), working), true)
  assert.equal(threadMatchesFilter(thread({ status: "awaiting-approval" }), working), true)
  assert.equal(threadMatchesFilter(thread(), working, "monitoring"), true)
  assert.equal(threadMatchesFilter(thread({ status: "failed" }), working), false)
  const codex = { threads: "all", agent: "codex" }
  assert.equal(threadMatchesFilter(thread(), codex), false)
  assert.equal(threadMatchesFilter(thread({ provider: { kind: "codex", instance: "default" } }), codex), true)
})

test("stored filters are read back only when valid", () => {
  assert.equal(isFiltering(DEFAULT_SIDEBAR_FILTER), false)
  assert.deepEqual(readSidebarFilter({ threads: "pinned", agent: "codex" }), { threads: "pinned", agent: "codex" })
  assert.equal(readSidebarFilter({ threads: "starred", agent: null }), undefined)
  assert.equal(readSidebarFilter({ threads: "all", agent: 4 }), undefined)
  assert.equal(readSidebarFilter(null), undefined)
})
