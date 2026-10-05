import assert from "node:assert/strict"
import test from "node:test"

import {
  agentItemChangeSummary,
  agentItemLabel,
  agentItemResultText,
  agentItemTool,
  agentItemWriteResult,
  parseAgentItemResult,
  splitChecklistPreview,
} from "./src/lib/agentItemTools.ts"

const taskRow = { kind: "task", id: "7b0c", key: "ADE-14", title: "Fix flaky login test", status: "inbox", priority: 2, project_id: "p1", created_by_thread: "t1", agent_editable: true, criteria_done: 1, criteria_total: 3, latest_run: null, link: "kybern://task/7b0c" }
const noteRow = { kind: "note", id: "n1", title: "Release plan", scope: "project", project_id: "p1", thread_id: null, created_by_thread: null, agent_editable: false, revision: 4, updated_at: "2026-10-05T00:00:00Z", link: "kybern://note/n1" }
const mcp = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] })

test("tool names are recognised under every harness's namespacing", () => {
  assert.deepEqual(agentItemTool("mcp__kybern__kybern_task_create"), { name: "task_create", kind: "task", write: true })
  assert.deepEqual(agentItemTool("kybern_notes_search"), { name: "notes_search", kind: "note", write: false })
  assert.deepEqual(agentItemTool("mcp:kybern/kybern_note_append"), { name: "note_append", kind: "note", write: true })
  assert.equal(agentItemTool("kybern_task_claim")?.write, true)
  assert.equal(agentItemTool("kybern_computer_act"), null)
  assert.equal(agentItemTool("mykybern_task_create"), null)
  assert.equal(agentItemTool("kybern_task_created"), null)
})

test("results parse out of Claude, Codex and bare envelopes", () => {
  const created = parseAgentItemResult(mcp({ ...taskRow, action: "created" }))
  assert.equal(created.kind, "task")
  assert.equal(created.action, "created")
  assert.equal(created.key, "ADE-14")
  assert.equal(created.criteriaTotal, 3)
  assert.equal(created.createdByThread, "t1")
  assert.deepEqual(parseAgentItemResult({ result: mcp({ ...noteRow, action: "appended" }) }).action, "appended")
  assert.equal(parseAgentItemResult(JSON.stringify(noteRow)).title, "Release plan")
  assert.deepEqual(parseAgentItemResult(mcp({ tasks: [taskRow, taskRow], truncated: true })), { kind: "tasks", count: 2, truncated: true })
  assert.deepEqual(parseAgentItemResult(mcp({ notes: [] })), { kind: "notes", count: 0, truncated: false })
  assert.equal(parseAgentItemResult({ content: [{ type: "text", text: "Waiting for the user to approve" }] }), null)
  assert.equal(parseAgentItemResult(null), null)
  assert.equal(parseAgentItemResult(mcp({ kind: "task", title: "no id" })), null)
})

test("only writes that name an item get a card", () => {
  assert.equal(agentItemWriteResult(parseAgentItemResult(mcp(taskRow))), null)
  assert.equal(agentItemWriteResult(parseAgentItemResult(mcp({ tasks: [] }))), null)
  const updated = agentItemWriteResult(parseAgentItemResult(mcp({ ...taskRow, action: "updated", changes: ["check 2 criteria", "set priority High"] })))
  assert.equal(agentItemChangeSummary(updated), "Check 2 criteria, set priority High")
  assert.equal(agentItemChangeSummary(agentItemWriteResult(parseAgentItemResult(mcp({ ...taskRow, action: "claimed" })))), "Working on it in this chat")
  assert.equal(agentItemChangeSummary(agentItemWriteResult(parseAgentItemResult(mcp({ ...noteRow, action: "appended" })))), "Added text")
})

test("labels follow the call's state and name the task", () => {
  const tool = (name) => agentItemTool(`mcp__kybern__kybern_${name}`)
  const task = parseAgentItemResult(mcp(taskRow))
  assert.equal(agentItemLabel(tool("notes_search"), { query: "release" }, null, true, false), "Searched notes for “release”")
  assert.equal(agentItemLabel(tool("notes_search"), {}, null, false, false), "Searching notes")
  assert.equal(agentItemLabel(tool("task_read"), { task: "ade-14" }, null, true, false), "Read task ADE-14")
  assert.equal(agentItemLabel(tool("task_read"), { task: "kybern://task/7b0c" }, task, true, false), "Read task ADE-14")
  assert.equal(agentItemLabel(tool("task_create"), {}, null, true, false), "Created task")
  assert.equal(agentItemLabel(tool("task_create"), {}, null, false, false), "Creating a task")
  assert.equal(agentItemLabel(tool("note_append"), {}, null, true, false), "Added to note")
  assert.equal(agentItemLabel(tool("task_update"), { task: "ADE-14" }, null, true, false), "Updated task ADE-14")
  assert.equal(agentItemLabel(tool("task_claim"), { task: "ADE-14" }, null, true, false), "Claimed ADE-14")
  assert.equal(agentItemLabel(tool("task_create"), {}, null, true, true), "Failed to create a task")
  assert.equal(agentItemLabel(tool("note_read"), {}, parseAgentItemResult(mcp(noteRow)), true, false), "Read note “Release plan”")
})

test("a task preview splits its description from its checklist", () => {
  assert.deepEqual(splitChecklistPreview("Login fails on retry.\n\n- [ ] Add a test\n- [x] Find the race\n```\n- [ ] not a criterion\n```"), {
    text: "Login fails on retry.\n\n```\n- [ ] not a criterion\n```",
    items: [{ text: "Add a test", checked: false }, { text: "Find the race", checked: true }],
  })
  assert.deepEqual(splitChecklistPreview(""), { text: "", items: [] })
})

test("raw results indent their JSON and leave other text alone", () => {
  assert.equal(agentItemResultText('{"a":1}'), '{\n  "a": 1\n}')
  assert.equal(agentItemResultText("Task ADE-9 not found."), "Task ADE-9 not found.")
})
