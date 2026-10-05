import assert from "node:assert/strict"
import test from "node:test"

import {
  approxTokens,
  boardColumns,
  buildTaskPrompt,
  composeTaskBody,
  countTasks,
  dropAction,
  findTaskKeys,
  formatTokens,
  groupTasks,
  isGroupCollapsed,
  keyMatchesQuery,
  matchesFilter,
  parseTaskKeyQuery,
  placeAt,
  plainInline,
  rankBetween,
  readTaskPrefs,
  runOutcome,
  searchTasks,
  shortActivity,
  splitTaskBody,
  splitTaskKey,
  suggestionQuery,
  taskActivity,
} from "./src/state/tasksModel.ts"
import { projectHue } from "../../packages/kybern-client/src/projectColors.ts"

const NOW = Date.parse("2026-10-05T12:00:00Z")
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString()

let serial = 0
function task(patch = {}) {
  serial++
  return {
    id: `t${serial}`,
    key: `ADE-${serial}`,
    scope: "project",
    project_id: "p1",
    title: `Task ${serial}`,
    body: "",
    status: "todo",
    priority: 0,
    rank: serial * 1024,
    note_ids: [],
    runs: [],
    revision: 1,
    created_at: ago(120),
    updated_at: ago(60),
    status_changed_at: ago(60),
    ...patch,
  }
}

test("task keys parse with or without a prefix", () => {
  assert.deepEqual(splitTaskKey("ADE-14"), { prefix: "ADE", number: 14 })
  assert.deepEqual(splitTaskKey("ade-14"), { prefix: "ADE", number: 14 })
  assert.equal(splitTaskKey("ADE14"), null)
  assert.equal(splitTaskKey("A-1"), null)
  assert.deepEqual(parseTaskKeyQuery("ADE-14"), { prefix: "ADE", number: 14 })
  assert.deepEqual(parseTaskKeyQuery("ade 14"), { prefix: "ADE", number: 14 })
  assert.deepEqual(parseTaskKeyQuery("ade14"), { prefix: "ADE", number: 14 })
  assert.deepEqual(parseTaskKeyQuery("#14"), { prefix: null, number: 14 })
  assert.deepEqual(parseTaskKeyQuery("14"), { prefix: null, number: 14 })
  assert.equal(parseTaskKeyQuery("conflict banner"), null)
  assert.equal(keyMatchesQuery("MOB-7", "7"), true)
  assert.equal(keyMatchesQuery("MOB-7", "ade-7"), false)
  assert.equal(keyMatchesQuery("MOB-7", "mob7"), true)
  assert.deepEqual(findTaskKeys("Blocked by ADE-18 and TSK-3, not ade-4"), [
    { key: "ADE-18", index: 11 },
    { key: "TSK-3", index: 22 },
  ])
})

test("search ranks the key first, then titles, then bodies", () => {
  const a = task({ key: "ADE-14", title: "Migrate Cursor sessions" })
  const b = task({ key: "ADE-15", title: "Banner when the CLI edits a note", body: "cursor position" })
  const c = task({ key: "MOB-14", title: "Pace streaming" })
  assert.deepEqual(searchTasks([b, c, a], "ADE-14").map((t) => t.key), ["ADE-14"])
  assert.deepEqual(searchTasks([b, c, a], "14").map((t) => t.key).sort(), ["ADE-14", "MOB-14"])
  assert.deepEqual(searchTasks([b, a], "cursor").map((t) => t.key), ["ADE-14", "ADE-15"])
})

test("groups follow the status order and skip empty groups", () => {
  const tasks = [
    task({ status: "inbox" }),
    task({ status: "running" }),
    task({ status: "todo", rank: 5000 }),
    task({ status: "todo", rank: 10 }),
    task({ status: "done", status_changed_at: ago(5) }),
    task({ status: "done", status_changed_at: ago(1) }),
  ]
  const groups = groupTasks(tasks, { grouping: "status", ordering: "manual", showDone: true, showCanceled: true }, [])
  assert.deepEqual(groups.map((g) => g.status), ["running", "todo", "inbox", "done"])
  assert.deepEqual(groups[1].tasks.map((t) => t.rank), [10, 5000])
  // Done reads newest first.
  assert.equal(groups[3].tasks[0].status_changed_at, ago(1))
  const hidden = groupTasks(tasks, { grouping: "status", ordering: "manual", showDone: false, showCanceled: true }, [])
  assert.equal(hidden.some((g) => g.status === "done"), false)
  assert.equal(isGroupCollapsed({ collapsed: {} }, { key: "status:done", status: "done" }), true)
  assert.equal(isGroupCollapsed({ collapsed: { "status:done": false } }, { key: "status:done", status: "done" }), false)
  assert.equal(isGroupCollapsed({ collapsed: {} }, { key: "status:todo", status: "todo" }), false)
})

test("project and priority grouping", () => {
  const tasks = [
    task({ project_id: "p2", priority: 1 }),
    task({ scope: "global", project_id: null, priority: 0 }),
    task({ project_id: "p1", priority: 3 }),
  ]
  const byProject = groupTasks(tasks, { grouping: "project", ordering: "manual", showDone: true, showCanceled: true }, [
    { id: "p1", name: "ade" },
    { id: "p2", name: "mobile" },
  ])
  assert.deepEqual(byProject.map((g) => g.label), ["ade", "mobile", "Global"])
  const byPriority = groupTasks(tasks, { grouping: "priority", ordering: "manual", showDone: true, showCanceled: true }, [])
  assert.deepEqual(byPriority.map((g) => g.label), ["Urgent", "Medium", "No priority"])
})

test("board columns hide Canceled until it has tasks", () => {
  const columns = boardColumns([task({ status: "todo" })], { ordering: "manual", showDone: true, showCanceled: true })
  assert.deepEqual(columns.map((c) => c.status), ["inbox", "todo", "running", "needs_review", "done"])
  const withCanceled = boardColumns([task({ status: "canceled" })], { ordering: "manual", showDone: false, showCanceled: true })
  assert.deepEqual(withCanceled.map((c) => c.status), ["inbox", "todo", "running", "needs_review", "canceled"])
})

test("drops: user statuses move, Running sends, Needs review refuses", () => {
  assert.equal(dropAction("todo"), "move")
  assert.equal(dropAction("done"), "move")
  assert.equal(dropAction("running"), "send")
  assert.equal(dropAction("needs_review"), "none")
})

test("rank math places a task between its neighbours", () => {
  assert.equal(rankBetween(undefined, undefined), 0)
  assert.equal(rankBetween(undefined, 100), 100 - 1024)
  assert.equal(rankBetween(100, undefined), 100 + 1024)
  assert.equal(rankBetween(100, 200), 150)
  const column = [
    { id: "a", rank: 0 },
    { id: "b", rank: 1024 },
    { id: "c", rank: 2048 },
  ]
  // Move c to the top.
  assert.deepEqual(placeAt(column, "c", 0), { beforeId: "a", rank: -1024 })
  // Move a between b and c.
  assert.deepEqual(placeAt(column, "a", 1), { beforeId: "c", rank: 1536 })
  // A new arrival at the end.
  assert.deepEqual(placeAt(column, "z", 3), { beforeId: null, rank: 3072 })
  // Into an empty column.
  assert.deepEqual(placeAt([], "z", 0), { beforeId: null, rank: 0 })
})

test("the body splits into a description and acceptance criteria", () => {
  const body = "Keep the unsaved text.\n\nShow a banner.\n\nDone when:\n\n- [x] The banner appears\n- [ ] Reloading keeps the caret\n  - nested detail\n"
  const { description, criteria } = splitTaskBody(body)
  assert.equal(description, "Keep the unsaved text.\n\nShow a banner.")
  assert.deepEqual(criteria, [
    { checked: true, text: "The banner appears" },
    { checked: false, text: "Reloading keeps the caret", extra: ["  - nested detail"] },
  ])
  const composed = composeTaskBody(description, criteria)
  assert.equal(composed, "Keep the unsaved text.\n\nShow a banner.\n\n- [x] The banner appears\n- [ ] Reloading keeps the caret\n  - nested detail\n")
  // Stable once composed.
  assert.equal(composeTaskBody(splitTaskBody(composed).description, splitTaskBody(composed).criteria), composed)
  assert.equal(composeTaskBody("", []), "")
  // Checklists inside code stay in the description.
  assert.equal(splitTaskBody("```\n- [ ] not a criterion\n```").criteria.length, 0)
  assert.equal(composeTaskBody("", [{ checked: false, text: "  " }]), "")
})

test("the prompt carries title, description, criteria and a saved follow-up", () => {
  const prompt = buildTaskPrompt({
    title: "Show a conflict banner when the CLI edits an open note",
    description: "Keep the unsaved text.",
    criteria: [
      { checked: false, text: "The banner appears within a second" },
      { checked: true, text: "Blocked on [ADE-14](kybern://task/abc)" },
    ],
    pendingFollowup: "Also check the mobile app.",
  })
  assert.equal(
    prompt,
    "Show a conflict banner when the CLI edits an open note.\n\nKeep the unsaved text.\n\nDone when:\n– The banner appears within a second\n– Blocked on ADE-14\n\nAlso check the mobile app.",
  )
  assert.equal(buildTaskPrompt({ title: "Ship it?", description: "", criteria: [] }), "Ship it?")
  assert.equal(plainInline("**Bold** `code` [link](https://x)"), "Bold code link")
})

test("context sizes read as approximate tokens", () => {
  assert.equal(approxTokens(4400), 1100)
  assert.equal(formatTokens(1100), "1.1k")
  assert.equal(formatTokens(700), "0.7k")
  assert.equal(formatTokens(30), "0.1k")
  assert.equal(formatTokens(24_400), "24k")
  assert.equal(suggestionQuery("Show a conflict banner when the CLI edits an open note"), "conflict banner cli edits")
})

test("counts and filters", () => {
  const tasks = [
    task({ status: "inbox" }),
    task({ status: "running" }),
    task({ status: "needs_review", scope: "global", project_id: null }),
    task({ status: "done", status_changed_at: ago(60) }),
    task({ status: "done", status_changed_at: ago(60 * 24 * 30) }),
  ]
  const counts = countTasks(tasks, NOW)
  assert.equal(counts.all, 3)
  assert.equal(counts.inbox, 1)
  assert.equal(counts.running, 1)
  assert.equal(counts.needs_review, 1)
  assert.equal(counts.done, 1)
  assert.equal(counts.global, 1)
  assert.equal(counts.projects.p1, 2)
  assert.equal(tasks.filter((t) => matchesFilter(t, "done", NOW)).length, 1)
  assert.equal(tasks.filter((t) => matchesFilter(t, "project:p1", NOW)).length, 4)
  assert.equal(tasks.filter((t) => matchesFilter(t, "global", NOW)).length, 1)
})

test("runs read as outcomes and short activity", () => {
  const run = { thread_id: "x", number: 2, provider: { kind: "claude-code", instance: "default" }, started_at: ago(12), state: "running" }
  assert.equal(runOutcome(run, NOW), "Running for 12m")
  assert.equal(runOutcome({ ...run, state: "interrupted", ended_at: ago(10) }, NOW), "Canceled after 2m")
  assert.equal(runOutcome({ ...run, state: "completed", started_at: ago(90), ended_at: ago(10) }, NOW), "Finished in 1h 20m")
  assert.equal(shortActivity("Editing crates/kybern-drivers/src/cursor.rs"), "Editing cursor.rs")
  assert.equal(shortActivity("Running pnpm typecheck"), "Running typecheck")
  const events = taskActivity(task({ created_at: ago(180), status_changed_at: ago(170), status: "todo", source_note_id: "n1", runs: [run] }))
  assert.deepEqual(events.map((e) => e.kind), ["created", "status", "run"])
})

test("projects take distinct hues in the order they were added", () => {
  const projects = [
    { id: "b", created_at: "2026-01-02" },
    { id: "a", created_at: "2026-01-01" },
    { id: "c", created_at: "2026-01-03" },
  ]
  const hues = ["a", "b", "c"].map((id) => projectHue(id, projects))
  assert.equal(new Set(hues).size, 3)
  assert.equal(projectHue("a", projects), projectHue("a", [...projects].reverse()))
  // The oldest project takes the first hue; the free-chat project takes none.
  assert.equal(projectHue("a", projects), 295)
  assert.equal(projectHue("b", [...projects, { id: "00000000-0000-0000-0000-000000000001", created_at: "2025-01-01" }]), 185)
})

test("view preferences survive bad storage", () => {
  assert.equal(readTaskPrefs(null).view, "list")
  const prefs = readTaskPrefs({ view: "board", grouping: "nope", showHints: false, filter: "project:abc", collapsed: { a: true, b: "x" } })
  assert.equal(prefs.view, "board")
  assert.equal(prefs.grouping, "status")
  assert.equal(prefs.showHints, false)
  assert.equal(prefs.filter, "project:abc")
  assert.deepEqual(prefs.collapsed, { a: true })
  assert.equal(readTaskPrefs({ filter: "bogus" }).filter, "all")
})
