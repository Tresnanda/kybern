import assert from "node:assert/strict"
import test from "node:test"

const {
  createComposerWindowHold,
  composerStackedMounts,
  composerInputMounts,
  composerDraftAttachmentsForStore,
  COMPOSER_WINDOW_HOLD_DELAY_MS,
} = await import("./src/lib/composerWindowHold.ts")

test("blur or focus loss is not permission to unmount composer stacked panels", () => {
  let hidden = false
  const hold = createComposerWindowHold({ delayMs: 10, isHidden: () => hidden })
  hold.sync()
  hold.flush()
  assert.equal(hold.isHeld(), false)
  hold.sync()
  assert.equal(hold.isHeld(), false)
  hold.dispose()
})

test("occlusion waits the delay, then holds until the page is visible again", () => {
  let hidden = true
  const hold = createComposerWindowHold({ delayMs: 50, isHidden: () => hidden })
  hold.sync()
  assert.equal(hold.isHeld(), false, "brief occlusion must not drop stacked panels")
  hold.flush()
  assert.equal(hold.isHeld(), true)
  hidden = false
  hold.sync()
  assert.equal(hold.isHeld(), false)
  hold.dispose()
})

test("becoming visible during the delay cancels the hold", () => {
  let hidden = true
  const hold = createComposerWindowHold({ delayMs: 1_000, isHidden: () => hidden })
  hold.sync()
  hidden = false
  hold.sync()
  hold.flush()
  assert.equal(hold.isHeld(), false)
  hold.dispose()
})

test("the hold delay leaves brief occlusion (Mission Control) alone", () => {
  assert.equal(COMPOSER_WINDOW_HOLD_DELAY_MS, 400)
})

test("held windows drop stacked panels and keep the composer input mounted", () => {
  assert.equal(composerStackedMounts(false), true)
  assert.equal(composerStackedMounts(true), false)
  assert.equal(composerInputMounts(false), true)
  assert.equal(composerInputMounts(true), true)
})

test("showing the window remounts stacked panels from store while the input never unmounts", () => {
  let hidden = true
  const hold = createComposerWindowHold({ delayMs: 50, isHidden: () => hidden })
  const mounts = []
  hold.subscribe((held) => mounts.push({
    stacked: composerStackedMounts(held),
    input: composerInputMounts(held),
  }))
  hold.sync()
  hold.flush()
  assert.deepEqual(mounts.at(-1), { stacked: false, input: true })
  hidden = false
  hold.sync()
  assert.deepEqual(mounts.at(-1), { stacked: true, input: true })
  hold.dispose()
})

test("persisted drafts drop attachment preview blobs so unmounting the input would lose them", () => {
  const stored = composerDraftAttachmentsForStore([
    { id: "asset", name: "shot.png", media_type: "image/png", size: 48, preview: "blob:preview" },
    { id: "note", name: "note.md", media_type: "text/markdown", size: 12 },
  ])
  assert.deepEqual(stored, [
    { id: "asset", name: "shot.png", media_type: "image/png", size: 48 },
    { id: "note", name: "note.md", media_type: "text/markdown", size: 12 },
  ])
  assert.equal("preview" in stored[0], false)
})
