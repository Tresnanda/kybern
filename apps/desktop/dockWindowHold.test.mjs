import assert from "node:assert/strict"
import test from "node:test"

const {
  createDockWindowHold,
  dockPaneBodyMounts,
  DOCK_WINDOW_HOLD_DELAY_MS,
} = await import("./src/lib/dockWindowHold.ts")

test("blur or focus loss is not permission to unmount reconstructible dock panes", () => {
  let hidden = false
  const hold = createDockWindowHold({ delayMs: 10, isHidden: () => hidden })
  hold.sync()
  hold.flush()
  assert.equal(hold.isHeld(), false)
  hold.sync()
  assert.equal(hold.isHeld(), false)
  hold.dispose()
})

test("occlusion waits the delay, then holds until the page is visible again", () => {
  let hidden = true
  const hold = createDockWindowHold({ delayMs: 50, isHidden: () => hidden })
  hold.sync()
  assert.equal(hold.isHeld(), false, "brief occlusion must not drop dock sessions")
  hold.flush()
  assert.equal(hold.isHeld(), true)
  hidden = false
  hold.sync()
  assert.equal(hold.isHeld(), false)
  hold.dispose()
})

test("becoming visible during the delay cancels the hold", () => {
  let hidden = true
  const hold = createDockWindowHold({ delayMs: 1_000, isHidden: () => hidden })
  hold.sync()
  hidden = false
  hold.sync()
  hold.flush()
  assert.equal(hold.isHeld(), false)
  hold.dispose()
})

test("the hold delay leaves brief occlusion (Mission Control) alone", () => {
  assert.equal(DOCK_WINDOW_HOLD_DELAY_MS, 400)
})

test("held windows keep the terminal body and drop reconstructible pane bodies", () => {
  const panes = ["collaboration", "activity", "changes", "terminal", "explorer", "artifacts"]
  for (const id of panes) {
    assert.equal(dockPaneBodyMounts(id, false), true, `${id} mounts while the window is shown`)
  }
  assert.equal(dockPaneBodyMounts("terminal", true), true)
  for (const id of panes.filter((id) => id !== "terminal")) {
    assert.equal(dockPaneBodyMounts(id, true), false, `${id} unmounts while the window is hidden`)
  }
})
