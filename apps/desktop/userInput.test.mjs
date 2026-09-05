import assert from "node:assert/strict"
import test from "node:test"
import { questionsFor, questionResponse, isUserInput } from "./src/lib/userInput.ts"
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
