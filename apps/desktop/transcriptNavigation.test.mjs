import assert from "node:assert/strict"
import test from "node:test"
import { createTranscriptNavigation } from "./src/lib/transcriptNavigation.ts"
const turn = (id, text, answer, running = false) => ({ turnId: id, user: { id: `user-${id}`, message: { parts: [{ type: "text", text }] } }, answer: { text: answer }, running })
test("navigation reaches every historical user prompt without a mounted DOM", () => {
  const build = createTranscriptNavigation()
  const turns = Array.from({ length: 400 }, (_, i) => turn(String(i), `Question ${i}`, `Answer ${i}`))
  const entries = build(turns)
  assert.equal(entries.length, 400)
  assert.equal(entries[200].id, "user-200")
  assert.equal(entries[399].turnIndex, 399)
  assert.equal(entries[399].ariaLabel, "Go to user prompt 400 of 400")
  const prepended = build([turn("older", "Older", "Old answer"), ...turns])
  assert.equal(prepended[201].id, "user-200")
  assert.equal(prepended[201].turnIndex, 201)
})
test("assistant text stays preview context without adding a rail strip", () => {
  const build = createTranscriptNavigation()
  const source = "A sentence with details. ".repeat(40)
  const entries = build([turn("a", "Question", source, true)])
  assert.equal(entries.length, 1)
  assert.match(entries[0].description, /^A sentence with details/)
  assert.equal(build([turn("a", "Question", source + " more", true)]), entries)
  const edited = build([turn("a", "Corrected question", source, true)])
  assert.notEqual(edited, entries)
  assert.equal(edited[0].label, "Corrected question")
  assert.equal(build([turn("a", "Corrected question", source, false)]).length, 1)
})
test("settled assistant-only continuations do not create prompt strips", () => {
  const build = createTranscriptNavigation()
  const continuation = { turnId: "continuation", answer: { text: "Background continuation" }, running: false }
  assert.deepEqual(build([turn("a", "Question", "Answer"), continuation]), [
    {
      id: "user-a",
      label: "Question",
      description: "Answer",
      ariaLabel: "Go to user prompt 1 of 1",
      turnIndex: 0,
      role: "user",
    },
  ])
})
