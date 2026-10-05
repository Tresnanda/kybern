import assert from "node:assert/strict"
import test from "node:test"
import { connectorApproval, connectorApprovalResponse, questionsFor, questionResponse, isUserInput } from "./src/lib/userInput.ts"
const questions = [{ id: "sections", question: "Which sections?", multiSelect: true, options: [{ label: "Intro", description: "Opening" }] }]
test("questions encode Claude text keys, Codex ids and OpenCode ordered arrays", () => {
  const answers = [["Intro", "Custom section"]]
  const approval = (tool_name) => ({ tool_name, input: { questions } })
  assert.deepEqual(questionResponse(approval("AskUserQuestion"), answers), { answers: { "Which sections?": "Intro, Custom section" } })
  assert.deepEqual(questionResponse(approval("request_user_input"), answers), { answers: { sections: { answers: answers[0] } } })
  assert.deepEqual(questionResponse(approval("opencode_question"), answers), { answers })
})
test("custom, multi-select, secret and empty answers preserve question semantics", () => {
  const approval = { tool_name: "request_user_input", input: { questions: [{ id:"secret", question:"Name", isSecret:true, custom:false, multiple:true }] } }
  assert.deepEqual(questionsFor(approval)[0], { id:"secret", title:"Name", header:"", secret:true, custom:false, multiple:true, options:[] })
  assert.throws(() => questionResponse(approval, [[]]), /Answer each question/)
  assert.equal(isUserInput(approval), true)
  assert.equal(isUserInput({ tool_name:"Bash" }), false)
})
test("Codex per-app Computer Use consent is a connector approval, other elicitations are forms", () => {
  const approval = { tool_name: "mcp_elicitation", summary: 'Allow Computer Use to use "ChatGPT"?', input: { serverName: "cua_repl", mode: "form", message: 'Allow Computer Use to use "ChatGPT"?', requestedSchema: { type: "object", properties: {} }, _meta: { codex_approval_kind: "mcp_tool_call", connector_name: "Computer Use", persist: ["session", "always"], riskLevel: "high", subtitle: "Allowing ChatGPT to use this app introduces new risks.", tool_params_display: [{ display_name: "App", name: "app", value: "ChatGPT" }] } } }
  assert.deepEqual(connectorApproval(approval), { connector: "Computer Use", app: "ChatGPT", message: 'Allow Computer Use to use "ChatGPT"?', subtitle: "Allowing ChatGPT to use this app introduces new risks.", persist: ["session", "always"] })
  assert.equal(connectorApproval({ tool_name: "mcp_elicitation", summary: "Sign in", input: { mode: "form", message: "Sign in", requestedSchema: { type: "object", properties: { token: { type: "string" } } } } }), null)
  assert.equal(connectorApproval({ tool_name: "AskUserQuestion", summary: "", input: { questions } }), null)
  assert.deepEqual(connectorApprovalResponse("session"), { action: "accept", content: {}, _meta: { persist: "session" } })
  assert.deepEqual(connectorApprovalResponse(null), { action: "accept", content: {} })
})

import { noteMentionPath, parseKybernMention, taskMentionPart, taskMentionPath } from "./src/lib/userInput.ts"

test("Kybern mention paths name notes, tasks and the computer", () => {
  assert.equal(noteMentionPath("n1"), "kybern://note/n1")
  assert.equal(taskMentionPath("t1"), "kybern://task/t1")
  assert.deepEqual(parseKybernMention("kybern://note/n1"), { kind: "note", id: "n1" })
  assert.deepEqual(parseKybernMention("kybern://computer"), { kind: "computer" })
  assert.equal(parseKybernMention("kybern://task/"), null)
  assert.deepEqual(taskMentionPart({ id: "t1", key: "ADE-14", title: " " }), { type: "mention", name: "Untitled task", path: "kybern://task/t1", display_name: "ADE-14 Untitled task" })
})

import { notesTasksConsent } from "./src/lib/userInput.ts"

test("notes and tasks consent reads the daemon's approval and ignores other tools", () => {
  const approval = { tool_name: "kybern_notes_tasks", summary: "Create task 'Fix flaky login test' in ade", input: { tool: "kybern_task_create", action: "create_task", kind: "task", title: "Fix flaky login test", project: "ade", priority: 2, priority_label: "High", criteria: 2, preview: "- [ ] Add a test\n- [ ] Fix it" } }
  assert.deepEqual(notesTasksConsent(approval), {
    action: "create_task", kind: "task", summary: "Create task 'Fix flaky login test' in ade", title: "Fix flaky login test", project: "ade",
    target: null, changes: [], preview: "- [ ] Add a test\n- [ ] Fix it", priority: 2, priorityLabel: "High", criteria: 2,
  })
  const update = notesTasksConsent({ tool_name: "kybern_notes_tasks", summary: "Check 1 criterion on ADE-14 'Fix'", input: { action: "update_task", kind: "task", target: { id: "t", key: "ADE-14", title: "Fix" }, changes: ["check 1 criterion"], preview: null } })
  assert.deepEqual(update.target, { id: "t", key: "ADE-14", title: "Fix" })
  assert.equal(update.preview, "")
  assert.equal(notesTasksConsent({ tool_name: "kybern_notes_tasks", summary: "", input: { action: "delete_task" } }), null)
  assert.equal(notesTasksConsent({ tool_name: "kybern_computer_use", summary: "", input: { app: "Notes" } }), null)
})
