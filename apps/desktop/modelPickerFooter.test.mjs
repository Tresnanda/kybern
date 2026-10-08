import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("./src/components/kybern/ModelPicker.tsx", import.meta.url), "utf8")

test("fast mode is a pressed-state lightning bolt, not a switch", () => {
  assert.match(source, /FastModeIcon/)
  assert.match(source, /aria-pressed=\{on\}/)
  assert.doesNotMatch(source, /<Switch\b|SegmentedControl/)
})

test("reset shows only when a trait or the effort differs from its default", () => {
  assert.match(source, /traitsChanged \|\| effortChanged/)
  assert.match(source, /Reset to default/)
})

test("the first nine model rows take mod+1..9 while the picker is open", () => {
  assert.match(source, /\.slice\(0, 9\)/)
  assert.match(source, /\[1-9\]/)
})

test("traits other than effort and fast open a menu row and keep focus while busy", () => {
  assert.match(source, /parameters\.filter\(\(parameter\) => parameter !== fast\)/)
  assert.match(source, /aria-disabled=\{busy \|\| undefined\}/)
})
