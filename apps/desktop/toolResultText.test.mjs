import assert from "node:assert/strict"
import { test } from "node:test"
import {
  TOOL_RESULT_CHAR_LIMIT,
  TOOL_RESULT_LINE_LIMIT,
  TOOL_RESULT_WRAP,
  joinToolResultRows,
  shouldVirtualizeToolResult,
  splitToolResultRows,
  toolResultCopyText,
} from "./src/lib/toolResultText.ts"

test("short tool results stay a single pre identity", () => {
  assert.equal(shouldVirtualizeToolResult("hello\nworld"), false)
  assert.equal(splitToolResultRows("hello\nworld"), null)
  assert.equal(splitToolResultRows(Array.from({ length: TOOL_RESULT_LINE_LIMIT }, (_, index) => `line ${index}`).join("\n")), null)
})

test("oversized results split into rows that concatenate to the source", () => {
  const lines = Array.from({ length: 80 }, (_, index) => `line ${index} é😀`)
  const text = `${lines.join("\n")}\n`
  assert.equal(shouldVirtualizeToolResult(text), true)
  const rows = splitToolResultRows(text)
  assert.ok(rows)
  assert.equal(joinToolResultRows(text, rows), text)
  assert.ok(rows.length >= 80)
})

test("long wrapped lines still concatenate without inserted newlines", () => {
  const line = "exact content ".repeat(TOOL_RESULT_WRAP)
  const text = `${line}\ntail`
  assert.ok(text.length > TOOL_RESULT_CHAR_LIMIT)
  const rows = splitToolResultRows(text)
  assert.ok(rows)
  assert.ok(rows.length > 2)
  assert.equal(joinToolResultRows(text, rows), text)
  assert.equal(rows.filter((row) => row.eol).length, 1)
})

test("a 33rd line or an 8193rd character virtualizes", () => {
  const lines = Array.from({ length: TOOL_RESULT_LINE_LIMIT + 1 }, (_, index) => `line ${index}`).join("\n")
  assert.equal(shouldVirtualizeToolResult(lines), true)
  assert.equal(shouldVirtualizeToolResult("x".repeat(TOOL_RESULT_CHAR_LIMIT)), false)
  assert.equal(shouldVirtualizeToolResult("x".repeat(TOOL_RESULT_CHAR_LIMIT + 1)), true)
})

test("select-all of mounted rows copies the full result; partial copy stays exact", () => {
  const full = `${"payload\n".repeat(40)}tail`
  const mounted = "payload\npayload\n"
  assert.equal(toolResultCopyText(full, mounted, mounted), full)
  assert.equal(toolResultCopyText(full, "payloadpayload", "payload\npayload"), full)
  assert.equal(toolResultCopyText(full, mounted, "payload"), "payload")
  assert.equal(toolResultCopyText(full, full, full), full)
})
