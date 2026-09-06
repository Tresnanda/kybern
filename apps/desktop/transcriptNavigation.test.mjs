import assert from "node:assert/strict"
import test from "node:test"
import { createTranscriptNavigation } from "./src/lib/transcriptNavigation.ts"
const turn = (id, text, answer, running = false) => ({ turnId: id, user: { id: `user-${id}`, message: { parts: [{ type: "text", text }] } }, answer: { text: answer }, running })
test("navigation reaches every historical message without a mounted DOM", () => {
  const build = createTranscriptNavigation()
  const turns = Array.from({ length: 400 }, (_, i) => turn(String(i), `Question ${i}`, `Answer ${i}`))
  const entries = build(turns)
  assert.equal(entries.length, 800)
  assert.equal(entries[400].id, "user-200")
  assert.equal(entries[799].turnIndex, 399)
  assert.equal(entries[799].ariaLabel, "Go to assistant message 800 of 800")
  const prepended = build([turn("older", "Older", "Old answer"), ...turns])
  assert.equal(prepended[402].id, "user-200")
  assert.equal(prepended[402].turnIndex, 201)
})
test("streaming past the preview prefix retains rail props, while edits refresh them", () => {
  const build = createTranscriptNavigation()
  const source = "A sentence with details. ".repeat(40)
  const entries = build([turn("a", "Question", source, true)])
  assert.equal(entries.length, 1)
  assert.equal(build([turn("a", "Question", source + " more", true)]), entries)
  const edited = build([turn("a", "Corrected question", source, true)])
  assert.notEqual(edited, entries)
  assert.equal(edited[0].label, "Corrected question")
  assert.equal(build([turn("a", "Corrected question", source, false)]).length, 2)
})
