import assert from "node:assert/strict"
import test from "node:test"

import {
  EMPTY_SELECTION,
  batchProjects,
  effectiveProject,
  extendSelection,
  focusAfterRemoval,
  listKeys,
  mentionedTaskIds,
  messageForTask,
  partitionBatch,
  pruneSelection,
  rangeSelection,
  runsLabel,
  selectAllSelection,
  toggleSelection,
} from "./src/state/tasksSelection.ts"

const order = ["a", "b", "c", "d", "e", "f"]
const ids = (state) => [...state.selected].sort()

test("toggling adds and removes one task and moves the anchor", () => {
  const one = toggleSelection(EMPTY_SELECTION, "b")
  assert.deepEqual(ids(one), ["b"])
  assert.equal(one.anchorId, "b")
  const two = toggleSelection(one, "d")
  assert.deepEqual(ids(two), ["b", "d"])
  const off = toggleSelection(two, "b")
  assert.deepEqual(ids(off), ["d"])
  assert.equal(off.anchorId, "b")
  // The input is not changed.
  assert.deepEqual(ids(one), ["b"])
})

test("a range runs from the anchor in the order shown and works backwards", () => {
  const anchored = toggleSelection(EMPTY_SELECTION, "b")
  assert.deepEqual(ids(rangeSelection(order, anchored, "d")), ["b", "c", "d"])
  assert.deepEqual(ids(rangeSelection(order, anchored, "a")), ["a", "b"])
})

test("a second range replaces the first from the same anchor and keeps single picks", () => {
  let state = toggleSelection(EMPTY_SELECTION, "b")
  state = rangeSelection(order, state, "e")
  assert.deepEqual(ids(state), ["b", "c", "d", "e"])
  state = rangeSelection(order, state, "c")
  assert.deepEqual(ids(state), ["b", "c"])
  state = toggleSelection(state, "f")
  state = rangeSelection(order, state, "e")
  assert.deepEqual(ids(state), ["b", "c", "e", "f"])
})

test("a range with no anchor starts at the focused row, else at the target", () => {
  assert.deepEqual(ids(rangeSelection(order, EMPTY_SELECTION, "d", "b")), ["b", "c", "d"])
  assert.deepEqual(ids(rangeSelection(order, EMPTY_SELECTION, "d")), ["d"])
  assert.equal(rangeSelection(order, EMPTY_SELECTION, "zz"), EMPTY_SELECTION)
})

test("an anchor that is no longer shown falls back to the focused row", () => {
  const state = toggleSelection(EMPTY_SELECTION, "gone")
  assert.deepEqual(ids(rangeSelection(order, state, "c", "a")), ["a", "b", "c", "gone"])
})

test("shift-arrows extend one row at a time and shrink on the way back", () => {
  let result = extendSelection(order, EMPTY_SELECTION, "b", 1)
  assert.equal(result.target, "c")
  assert.deepEqual(ids(result.state), ["b", "c"])
  result = extendSelection(order, result.state, "c", 1)
  assert.equal(result.target, "d")
  assert.deepEqual(ids(result.state), ["b", "c", "d"])
  result = extendSelection(order, result.state, "d", -1)
  assert.deepEqual(ids(result.state), ["b", "c"])
  result = extendSelection(order, result.state, "c", -1)
  assert.deepEqual(ids(result.state), ["b"])
  result = extendSelection(order, result.state, "b", -1)
  assert.equal(result.target, "a")
  assert.deepEqual(ids(result.state), ["a", "b"])
})

test("extending from a row the last range did not end at starts a new range there", () => {
  let result = extendSelection(order, EMPTY_SELECTION, "a", 1)
  assert.deepEqual(ids(result.state), ["a", "b"])
  // The focus moved to e with the plain arrow keys; the earlier pick stays.
  result = extendSelection(order, result.state, "e", 1)
  assert.equal(result.target, "f")
  assert.deepEqual(ids(result.state), ["a", "b", "e", "f"])
})

test("extending stops at the ends and starts from an end with nothing focused", () => {
  assert.equal(extendSelection(order, EMPTY_SELECTION, "f", 1).target, "f")
  assert.equal(extendSelection(order, EMPTY_SELECTION, null, 1).target, "a")
  assert.equal(extendSelection(order, EMPTY_SELECTION, null, -1).target, "f")
  assert.equal(extendSelection([], EMPTY_SELECTION, null, 1).target, null)
})

test("select all adds every task shown and keeps what was picked", () => {
  const state = toggleSelection(EMPTY_SELECTION, "zz")
  const all = selectAllSelection(order, state)
  assert.deepEqual(ids(all), ["a", "b", "c", "d", "e", "f", "zz"])
  assert.equal(all.anchorId, "zz")
  assert.equal(selectAllSelection([], state), state)
})

test("pruning drops what left and returns the same state when nothing did", () => {
  const state = rangeSelection(order, toggleSelection(EMPTY_SELECTION, "b"), "d")
  assert.equal(pruneSelection(state, () => true), state)
  const pruned = pruneSelection(state, (id) => id !== "b" && id !== "c")
  assert.deepEqual(ids(pruned), ["d"])
  assert.equal(pruned.anchorId, null)
  assert.equal(pruned.rangeEndId, null)
  assert.equal(pruneSelection(state, (id) => id !== "c").anchorId, "b")
})

test("focus after removal is the next row left standing, else the one before", () => {
  assert.equal(focusAfterRemoval(order, new Set(["b", "c"])), "d")
  assert.equal(focusAfterRemoval(order, new Set(["e", "f"])), "d")
  assert.equal(focusAfterRemoval(order, new Set(["a", "c", "f"])), "e")
  assert.equal(focusAfterRemoval(["a"], new Set(["a"])), null)
  assert.equal(focusAfterRemoval(order, new Set()), null)
})

const live = { number: 1, state: "running" }
const done = { number: 1, state: "completed" }
const item = (id, patch = {}) => ({ id, scope: "project", project_id: "p1", runs: [], ...patch })

test("tasks with a live run are skipped from a batch", () => {
  const tasks = [item("a"), item("b", { runs: [live] }), item("c", { runs: [done] }), item("d", { runs: [done, { number: 2, state: "waiting" }] })]
  const { starting, skipped } = partitionBatch(tasks)
  assert.deepEqual(starting.map((t) => t.id), ["a", "c"])
  assert.deepEqual(skipped.map((t) => t.id), ["b", "d"])
})

test("global tasks run in the chosen project and projects are counted once", () => {
  const global = item("g", { scope: "global", project_id: null })
  assert.equal(effectiveProject(global, null), null)
  assert.equal(effectiveProject(global, "p2"), "p2")
  assert.equal(effectiveProject(item("a", { project_id: "p1" }), "p2"), "p1")
  assert.deepEqual(batchProjects([item("a"), item("b"), global], "p1"), ["p1"])
  assert.deepEqual(batchProjects([item("a"), item("b", { project_id: "p3" }), global], "p3"), ["p1", "p3"])
  assert.deepEqual(batchProjects([global], null), [])
})

const mention = (id) => ({ type: "mention", name: id, path: `kybern://task/${id}`, display_name: id })
const text = (value) => ({ type: "text", text: value })

test("the tasks a message still mentions follow the batch's order", () => {
  const parts = [mention("c"), text(" "), mention("a"), text(" do it"), { type: "mention", name: "n", path: "kybern://note/a" }]
  assert.deepEqual(mentionedTaskIds(parts, ["a", "b", "c"]), ["a", "c"])
})

test("each task's copy of a batch message keeps only its own chip and tidies the spaces", () => {
  const parts = [mention("a"), text(" "), mention("b"), text(" "), mention("c"), text(" refactor them")]
  assert.deepEqual(messageForTask(parts, "b", ["a", "b", "c"]), [mention("b"), text(" refactor them")])
  assert.deepEqual(messageForTask(parts, "a", ["a", "b", "c"]), [mention("a"), text(" refactor them")])
  assert.deepEqual(messageForTask(parts, "c", ["a", "b", "c"]), [mention("c"), text(" refactor them")])
})

test("a batch message with no instructions leaves just the task's chip", () => {
  const parts = [mention("a"), text(" "), mention("b"), text(" ")]
  assert.deepEqual(messageForTask(parts, "b", ["a", "b"]), [mention("b"), text(" ")])
  assert.deepEqual(messageForTask(parts, "a", ["a", "b"]), [mention("a"), text(" ")])
})

test("other parts of the message are kept as they are", () => {
  const file = { type: "file_mention", path: "src/x.ts" }
  const parts = [mention("a"), text(" "), mention("b"), text(" look at "), file]
  assert.deepEqual(messageForTask(parts, "b", ["a", "b"]), [mention("b"), text(" look at "), file])
})

test("labels read naturally", () => {
  assert.equal(listKeys([]), "")
  assert.equal(listKeys(["ADE-3"]), "ADE-3")
  assert.equal(listKeys(["ADE-3", "ADE-4"]), "ADE-3 and ADE-4")
  assert.equal(listKeys(["ADE-3", "ADE-4", "ADE-14"]), "ADE-3, ADE-4 and ADE-14")
  assert.equal(runsLabel(1), "1 run")
  assert.equal(runsLabel(3), "3 runs")
})
