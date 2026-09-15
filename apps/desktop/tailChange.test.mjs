import assert from "node:assert/strict"
import test from "node:test"
import { diffTail } from "./src/lib/tailChange.ts"

test("diffTail classifies streaming updates by reference", () => {
  const a = { id: "a" }, b = { id: "b" }, c = { id: "c" }, c2 = { id: "c" }
  assert.deepEqual(diffTail(null, [a]), { kind: "rebuild" })
  const prev = [a, b, c]
  assert.deepEqual(diffTail(prev, prev), { kind: "same" })
  assert.deepEqual(diffTail(prev, [a, b, c]), { kind: "same" })
  assert.deepEqual(diffTail(prev, [a, b, c2]), { kind: "tail", index: 2, before: c, after: c2 })
  assert.deepEqual(diffTail(prev, [a, { id: "b" }, c]), { kind: "tail", index: 1, before: b, after: prev[1] === b ? b : b } )
  assert.deepEqual(diffTail(prev, [a, b, c, c2]), { kind: "append", after: c2 })
  assert.deepEqual(diffTail(prev, [a, b]), { kind: "rebuild" })
  assert.deepEqual(diffTail(prev, [a, { id: "b" }, c2]), { kind: "rebuild" })
  assert.deepEqual(diffTail(prev, [a, b, c2, c]), { kind: "rebuild" })
})
