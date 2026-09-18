import assert from "node:assert/strict"
import test from "node:test"

const {
  createRendererWindowHold,
  RENDERER_WINDOW_HOLD_DELAY_MS,
} = await import("./src/lib/rendererWindowHold.ts")

test("blur or focus loss is not permission to drop renderer runtimes", () => {
  let hidden = false
  let releases = 0
  const hold = createRendererWindowHold({ delayMs: 10, isHidden: () => hidden, onHold: () => { releases++ } })
  hold.sync()
  hold.flush()
  assert.equal(hold.isHeld(), false)
  hold.sync()
  assert.equal(hold.isHeld(), false)
  assert.equal(releases, 0)
  hold.dispose()
})

test("occlusion waits the delay, then releases until the page is visible again", () => {
  let hidden = true
  let releases = 0
  const hold = createRendererWindowHold({ delayMs: 50, isHidden: () => hidden, onHold: () => { releases++ } })
  hold.sync()
  assert.equal(hold.isHeld(), false, "brief occlusion must not drop the mermaid document")
  assert.equal(releases, 0)
  hold.flush()
  assert.equal(hold.isHeld(), true)
  assert.equal(releases, 1)
  hidden = false
  hold.sync()
  assert.equal(hold.isHeld(), false)
  assert.equal(releases, 1, "showing the window must not recreate runtimes until the next job")
  hold.dispose()
})

test("becoming visible during the delay cancels the release", () => {
  let hidden = true
  let releases = 0
  const hold = createRendererWindowHold({ delayMs: 1_000, isHidden: () => hidden, onHold: () => { releases++ } })
  hold.sync()
  hidden = false
  hold.sync()
  hold.flush()
  assert.equal(hold.isHeld(), false)
  assert.equal(releases, 0)
  hold.dispose()
})

test("the hold delay leaves brief occlusion (Mission Control) alone", () => {
  assert.equal(RENDERER_WINDOW_HOLD_DELAY_MS, 400)
})

test("a second occlusion after restore releases again", () => {
  let hidden = true
  let releases = 0
  const hold = createRendererWindowHold({ delayMs: 10, isHidden: () => hidden, onHold: () => { releases++ } })
  hold.sync()
  hold.flush()
  hidden = false
  hold.sync()
  hidden = true
  hold.sync()
  hold.flush()
  assert.equal(releases, 2)
  hold.dispose()
})
