import assert from "node:assert/strict"
import test from "node:test"
import {
  fitImageBlob,
  inlineImageBlob,
  dialogFitSize,
  dialogNeedsFit,
  dialogSkipFit,
  dialogUsesSource,
  DIALOG_INLINE_PASSTHROUGH_CHARS,
  DIALOG_MAX_HEIGHT,
  DIALOG_MAX_WIDTH,
} from "./src/lib/dialogImageFit.ts"

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="
const source = `data:image/png;base64,${png}`
const gif = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="

test("dialog fit never upscales and matches 1200×75dvh at 2× on 1440×900", () => {
  assert.deepEqual(dialogFitSize(4000, 3000), { width: 1800, height: 1350 })
  assert.deepEqual(dialogFitSize(3000, 4000), { width: 1013, height: 1350 })
  assert.deepEqual(dialogFitSize(600, 1800), { width: 450, height: 1350 })
  assert.deepEqual(dialogFitSize(1600, 900), { width: 1600, height: 900 })
  assert.deepEqual(dialogFitSize(80, 40), { width: 80, height: 40 })
  assert.equal(DIALOG_MAX_WIDTH, 2400)
  assert.equal(DIALOG_MAX_HEIGHT, 1350)
})

test("tiny data URLs keep their source instead of minting a display blob", () => {
  assert.equal(dialogUsesSource(source), true)
  assert.equal(dialogNeedsFit(source), false)
  assert.equal(dialogUsesSource(`data:image/png;base64,${"A".repeat(DIALOG_INLINE_PASSTHROUGH_CHARS)}`), false)
  assert.equal(dialogNeedsFit(`data:image/png;base64,${"A".repeat(DIALOG_INLINE_PASSTHROUGH_CHARS)}`), true)
  assert.equal(dialogNeedsFit("blob:https://kybern.local/1"), true)
  assert.equal(dialogNeedsFit("https://example.com/a.png"), false)
  assert.equal(dialogNeedsFit(""), false)
})

test("GIF sources skip fitting so the dialog keeps animation", () => {
  assert.equal(dialogSkipFit(gif), true)
  assert.equal(dialogNeedsFit(gif), false)
  assert.equal(dialogSkipFit("artifacts/loop.gif"), true)
  assert.equal(dialogSkipFit("photo.png", new Blob(["gif"], { type: "image/gif" })), true)
  assert.equal(dialogSkipFit("photo.png"), false)
})

test("data URLs become blobs without fetch", async () => {
  const blob = await inlineImageBlob(source)
  assert.equal(blob.type, "image/png")
  assert.ok(blob.size > 0)
})

test("fitImageBlob is a no-op when createImageBitmap is missing", async () => {
  const blob = new Blob(["image"], { type: "image/png" })
  assert.equal(await fitImageBlob(blob, DIALOG_MAX_WIDTH, DIALOG_MAX_HEIGHT), blob)
})

test("fitImageBlob does not freeze a GIF blob", async () => {
  const blob = new Blob(["gif"], { type: "image/gif" })
  assert.equal(await fitImageBlob(blob, DIALOG_MAX_WIDTH, DIALOG_MAX_HEIGHT), blob)
})
