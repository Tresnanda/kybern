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
