import assert from "node:assert/strict"
import test from "node:test"
import { harnessMarkGeometry, launchHarnesses } from "../lib/launchHarnesses.ts"

const known = new Set(["claude-code", "codex", "cursor", "opencode"])
const has = (kind) => known.has(kind)

test("one harness across the group shows one logo", () => {
  assert.deepEqual(launchHarnesses(["codex", "codex", "codex"], has), ["codex"])
})

test("distinct harnesses keep the order they first appear in", () => {
  assert.deepEqual(launchHarnesses(["codex", "claude-code", "codex", "cursor"], has), ["codex", "claude-code", "cursor"])
})

test("at most three logos, with no overflow entry", () => {
  assert.deepEqual(launchHarnesses(["codex", "claude-code", "cursor", "opencode"], has), ["codex", "claude-code", "cursor"])
})

test("an unknown or unresolved harness is the generic mark, once", () => {
  assert.deepEqual(launchHarnesses([null, undefined, "mystery", "codex"], has), [null, "codex"])
  assert.deepEqual(launchHarnesses([undefined], has), [null])
})

test("the logos always fit the 24 px badge and overlap", () => {
  for (const count of [1, 2, 3]) {
    const { size, step, width } = harnessMarkGeometry(count)
    assert.ok(width <= 24, `${count} logos are ${width}px wide`)
    if (count > 1) assert.ok(step < size, "neighbours overlap")
  }
})
