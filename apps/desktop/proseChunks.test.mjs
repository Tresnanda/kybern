import assert from "node:assert/strict"
import test from "node:test"
import { chunkProseText, markdownHostsProse } from "./src/lib/proseChunks.ts"

test("short prose is returned unchanged", () => {
  assert.equal(chunkProseText("a short paragraph", 1600), null)
  assert.equal(chunkProseText("x".repeat(1600), 1600), null)
})

test("chunks concatenate back to the source and break on whitespace", () => {
  const text = `${"word ".repeat(500)}end`
  const chunks = chunkProseText(text, 1600)
  assert.ok(chunks && chunks.length >= 2)
  assert.equal(chunks.join(""), text)
  assert.ok(chunks.slice(0, -1).every((chunk) => /\s$/.test(chunk)))
})

test("a token longer than the budget is hard-split", () => {
  const text = "a".repeat(3500)
  const chunks = chunkProseText(text, 1600)
  assert.deepEqual(chunks, ["a".repeat(1600), "a".repeat(1600), "a".repeat(300)])
  assert.equal(chunks.join(""), text)
})

test("only hosted markdown class names wrap prose chunks", () => {
  assert.equal(markdownHostsProse(), false)
  assert.equal(markdownHostsProse("chat-markdown--user"), false)
  assert.equal(markdownHostsProse("chat-markdown"), false)
  assert.equal(markdownHostsProse("chat-markdown--hosted"), true)
  assert.equal(markdownHostsProse("chat-markdown--hosted [&_*]:text-muted-foreground"), true)
})
