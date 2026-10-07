import assert from "node:assert/strict"
import test from "node:test"

import {
  EMPTY_NAV_HISTORY,
  NAV_HISTORY_LIMIT,
  canMoveNavHistory,
  moveNavHistory,
  navEntryFromSelected,
  navEntryKey,
  recordNavEntry,
} from "./src/state/navHistory.ts"

const thread = (id) => ({ kind: "thread", id })
const draft = (projectId, purpose) => ({ kind: "draft", draft: { projectId, ...(purpose ? { purpose } : {}) } })
const always = () => true

function record(...entries) {
  return entries.reduce((history, entry) => recordNavEntry(history, entry), EMPTY_NAV_HISTORY)
}
const keys = (history) => history.entries.map(navEntryKey)

test("the none selection is not a history entry", () => {
  assert.equal(navEntryFromSelected({ kind: "none" }), null)
  assert.deepEqual(navEntryFromSelected({ kind: "pulls" }), { kind: "pulls" })
})

test("recording pushes steps and ignores a repeat of the current view", () => {
  const history = record(thread("a"), { kind: "pulls" }, { kind: "pulls" }, thread("b"))
  assert.deepEqual(keys(history), ["thread:a", "pulls", "thread:b"])
  assert.equal(history.index, 2)
  assert.equal(recordNavEntry(history, thread("b")), history)
})

test("notes and tasks pages are distinct from their open item", () => {
  const history = record({ kind: "notes" }, { kind: "notes", noteId: "n1" }, { kind: "tasks" }, { kind: "tasks", taskId: "t1" })
  assert.deepEqual(keys(history), ["notes:", "notes:n1", "tasks:", "tasks:t1"])
})

test("back then forward walks the stack and lands on the same entries", () => {
  let history = record(thread("a"), thread("b"), thread("c"))
  const back = moveNavHistory(history, -1, always)
  assert.equal(navEntryKey(back.entry), "thread:b")
  history = back.history
  assert.equal(history.index, 1)
  assert.ok(canMoveNavHistory(history, 1, always))
  const forward = moveNavHistory(history, 1, always)
  assert.equal(navEntryKey(forward.entry), "thread:c")
  assert.equal(moveNavHistory(forward.history, 1, always), null)
  assert.equal(moveNavHistory(record(thread("a")), -1, always), null)
})

test("a new step after going back drops the forward steps", () => {
  const back = moveNavHistory(record(thread("a"), thread("b"), thread("c")), -1, always)
  const history = recordNavEntry(back.history, { kind: "usage" })
  assert.deepEqual(keys(history), ["thread:a", "thread:b", "usage"])
  assert.equal(canMoveNavHistory(history, 1, always), false)
})

test("deleted entries are skipped and dropped", () => {
  const history = record(thread("a"), thread("gone"), { kind: "notes", noteId: "gone" }, thread("b"))
  const valid = (entry) => !(entry.kind === "thread" && entry.id === "gone") && !(entry.kind === "notes" && entry.noteId === "gone")
  const back = moveNavHistory(history, -1, valid)
  assert.equal(navEntryKey(back.entry), "thread:a")
  assert.deepEqual(keys(back.history), ["thread:a", "thread:b"])
  assert.equal(back.history.index, 0)
  const forward = moveNavHistory(back.history, 1, valid)
  assert.equal(navEntryKey(forward.entry), "thread:b")
  // Nothing valid behind: no step is offered.
  assert.equal(canMoveNavHistory(record(thread("gone"), thread("b")), -1, valid), false)
})

test("a step that would show the current page again is skipped", () => {
  const history = record(thread("a"), thread("gone"), thread("a"))
  const valid = (entry) => entry.id !== "gone"
  assert.equal(moveNavHistory(history, -1, valid), null)
})

test("skipping forward keeps the index on the entry shown", () => {
  let history = record(thread("a"), thread("gone"), thread("b"), thread("c"))
  history = moveNavHistory(history, -1, always).history
  history = moveNavHistory(history, -1, always).history
  history = moveNavHistory(history, -1, always).history
  assert.equal(history.index, 0)
  const valid = (entry) => entry.id !== "gone"
  const forward = moveNavHistory(history, 1, valid)
  assert.equal(navEntryKey(forward.entry), "thread:b")
  assert.equal(forward.history.entries[forward.history.index], forward.entry)
})

test("a replacement swaps the current step instead of adding one", () => {
  const history = recordNavEntry(record(thread("a"), draft("p")), thread("new"), "replace")
  assert.deepEqual(keys(history), ["thread:a", "thread:new"])
  assert.equal(history.index, 1)
  // Replacing the first view seeds the history.
  assert.deepEqual(keys(recordNavEntry(EMPTY_NAV_HISTORY, draft("p"), "replace")), ["draft:p:"])
  // Replacing into the step behind collapses to one.
  assert.deepEqual(keys(recordNavEntry(record(thread("a"), draft("p")), thread("a"), "replace")), ["thread:a"])
})

test("moving between drafts keeps one draft step", () => {
  const history = record(thread("a"), draft("p"), draft("q"), draft("q", "coordinator"))
  assert.deepEqual(keys(history), ["thread:a", "draft:q:coordinator"])
  assert.equal(history.index, 1)
})

test("history is capped at the limit, oldest first", () => {
  let history = EMPTY_NAV_HISTORY
  for (let i = 0; i < NAV_HISTORY_LIMIT + 10; i++) history = recordNavEntry(history, thread(`t${i}`))
  assert.equal(history.entries.length, NAV_HISTORY_LIMIT)
  assert.equal(navEntryKey(history.entries[0]), "thread:t10")
  assert.equal(history.index, NAV_HISTORY_LIMIT - 1)
})
