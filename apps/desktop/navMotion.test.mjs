import assert from "node:assert/strict"
import test from "node:test"

import { pageDirection } from "./src/lib/navMotion.ts"

test("opening a subagent pushes forward and returning pushes back", () => {
  assert.equal(pageDirection(0, 1), "forward")
  assert.equal(pageDirection(1, 2), "forward")
  assert.equal(pageDirection(1, 0), "back")
  assert.equal(pageDirection(2, 1), "back")
})

test("moves between ordinary threads, or between siblings, do not animate", () => {
  assert.equal(pageDirection(0, 0), null)
  assert.equal(pageDirection(1, 1), null)
})
