import assert from "node:assert/strict"
import test from "node:test"
import { mentionArrowsSwitchChips, mentionAtCaret, parseMentionQuery, rankMentionNotes, rankMentionTasks } from "./src/views/composerMentions.ts"
import { keyMatchesQuery } from "./src/state/tasksModel.ts"

const note = (id, title, extra = {}) => ({ id, scope: "project", project_id: "p1", title, preview: "", checklist: { done: 0, total: 0 }, pinned: false, revision: 1, created_at: "2026-10-01", updated_at: "2026-10-01", ...extra })
const task = (id, key, title, extra = {}) => ({ id, key, scope: "project", project_id: "p1", title, body: "", status: "todo", priority: 0, rank: 0, note_ids: [], runs: [], revision: 1, created_at: "2026-10-01", updated_at: "2026-10-01", status_changed_at: "2026-10-01", ...extra })

test("typed prefixes pick a chip and leave the rest as the query", () => {
  assert.deepEqual(parseMentionQuery("note:login"), { kind: "note", prefixLength: 5, term: "login" })
  assert.deepEqual(parseMentionQuery("Tasks:"), { kind: "task", prefixLength: 6, term: "" })
  assert.deepEqual(parseMentionQuery("src:main"), { kind: null, prefixLength: 0, term: "src:main" })
})

test("@ opens the picker only at the start of a token", () => {
  assert.deepEqual(mentionAtCaret("@lo", 3), { start: 0, query: "lo" })
  assert.deepEqual(mentionAtCaret("ask @task:", 10), { start: 4, query: "task:" })
  assert.equal(mentionAtCaret("mail a@b.com", 12), null)
  assert.equal(mentionAtCaret("mail a@b", 8), null)
  assert.equal(mentionAtCaret("@lo and", 7), null)
})

test("arrows switch chips only before a search term is typed", () => {
  assert.equal(mentionArrowsSwitchChips(""), true)
  assert.equal(mentionArrowsSwitchChips("task:"), true)
  assert.equal(mentionArrowsSwitchChips("t"), false)
  assert.equal(mentionArrowsSwitchChips("note:lo"), false)
  assert.equal(mentionArrowsSwitchChips("src:"), false)
})

test("notes rank pinned first without a query and by title with one", () => {
  const notes = [note("a", "Alpha", { updated_at: "2026-10-03" }), note("b", "Beta", { pinned: true }), note("c", "Login flow", { preview: "alpha release" }), note("d", "Deleted", { deleted_at: "2026-10-02" })]
  assert.deepEqual(rankMentionNotes(notes, "", null, null).map((hit) => hit.note.id), ["b", "a", "c"])
  assert.deepEqual(rankMentionNotes(notes, "alpha", null, null).map((hit) => hit.note.id), ["a", "c"])
  assert.deepEqual(rankMentionNotes(notes, "zebra", new Map([["b", "…zebra…"]]), null).map((hit) => [hit.note.id, hit.snippet]), [["b", "…zebra…"]])
})

test("tasks match keys exactly and keep closed tasks last", () => {
  const tasks = [task("1", "ADE-14", "Fix login"), task("2", "ADE-4", "Login copy", { status: "done" }), task("3", "TSK-2", "Plan login", { scope: "global", project_id: null })]
  assert.deepEqual(rankMentionTasks(tasks, "14", null, keyMatchesQuery).map((item) => item.id), ["1"])
  assert.deepEqual(rankMentionTasks(tasks, "login", null, keyMatchesQuery).map((item) => item.id), ["1", "3", "2"])
  assert.deepEqual(rankMentionTasks(tasks, "", "p1", keyMatchesQuery).map((item) => item.id), ["1", "3", "2"])
})
