import assert from "node:assert/strict"
import test from "node:test"
import { harnessMarkGeometry, launchHarnesses } from "../lib/launchHarnesses.ts"

const known = new Set(["claude-code", "codex", "cursor", "opencode"])
const has = (kind) => known.has(kind)

test("one harness across the group shows one logo", () => {
  assert.deepEqual(launchHarnesses(["codex", "codex", "codex"], has), ["codex"])
})

test("distinct harnesses keep the order they first appear in", () => {
  assert.deepEqual(launchHarnesses(["cursor", "codex", "claude-code", "codex"], has), ["cursor", "codex"])
})

test("at most two logos, the first two harnesses, with no overflow entry", () => {
  assert.deepEqual(launchHarnesses(["codex", "claude-code", "cursor", "opencode"], has), ["codex", "claude-code"])
})

test("an unknown or unresolved harness is the generic mark, once", () => {
  assert.deepEqual(launchHarnesses([null, undefined, "mystery", "codex"], has), [null, "codex"])
  assert.deepEqual(launchHarnesses([undefined], has), [null])
})

test("one logo keeps the badge's circle; two plates fill the 24 px slot exactly", () => {
  assert.deepEqual(harnessMarkGeometry(1), { plate: 24, logo: 13, step: 0, ring: 0, width: 24 })
  const two = harnessMarkGeometry(2)
  assert.equal(two.width, 24)
  assert.equal(two.plate + two.step, 24)
  assert.equal(two.step, two.plate / 2, "the back plate is half covered")
  assert.ok(two.logo >= 11, `logos are ${two.logo}px`)
})
