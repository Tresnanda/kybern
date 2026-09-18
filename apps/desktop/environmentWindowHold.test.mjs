import assert from "node:assert/strict"
import test from "node:test"

const {
  createEnvironmentWindowHold,
  environmentPanelBodyMounts,
  ENVIRONMENT_WINDOW_HOLD_DELAY_MS,
} = await import("./src/lib/environmentWindowHold.ts")

test("blur or focus loss is not permission to unmount the environment card body", () => {
  let hidden = false
  const hold = createEnvironmentWindowHold({ delayMs: 10, isHidden: () => hidden })
  hold.sync()
  hold.flush()
  assert.equal(hold.isHeld(), false)
  hold.sync()
  assert.equal(hold.isHeld(), false)
  hold.dispose()
})

test("occlusion waits the delay, then holds until the page is visible again", () => {
  let hidden = true
  const hold = createEnvironmentWindowHold({ delayMs: 50, isHidden: () => hidden })
  hold.sync()
  assert.equal(hold.isHeld(), false, "brief occlusion must not drop the environment card")
  hold.flush()
  assert.equal(hold.isHeld(), true)
  hidden = false
  hold.sync()
  assert.equal(hold.isHeld(), false)
  hold.dispose()
})

test("becoming visible during the delay cancels the hold", () => {
  let hidden = true
  const hold = createEnvironmentWindowHold({ delayMs: 1_000, isHidden: () => hidden })
  hold.sync()
  hidden = false
  hold.sync()
  hold.flush()
  assert.equal(hold.isHeld(), false)
  hold.dispose()
})

test("the hold delay leaves brief occlusion (Mission Control) alone", () => {
  assert.equal(ENVIRONMENT_WINDOW_HOLD_DELAY_MS, 400)
})

test("held windows drop the reconstructible environment card body", () => {
  assert.equal(environmentPanelBodyMounts(false), true)
  assert.equal(environmentPanelBodyMounts(true), false)
})
