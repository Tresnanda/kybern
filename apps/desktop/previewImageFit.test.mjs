import assert from "node:assert/strict"
import test from "node:test"
import {
  fitImageBlob,
  inlineImageBlob,
  previewFitSize,
  previewNeedsFit,
  previewUsesSource,
  PREVIEW_INLINE_PASSTHROUGH_CHARS,
  PREVIEW_MAX_HEIGHT,
  PREVIEW_MAX_WIDTH,
} from "./src/lib/previewImageFit.ts"

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="
const source = `data:image/png;base64,${png}`

test("preview fit never upscales and matches the 280px chip at 2×", () => {
  assert.deepEqual(previewFitSize(1800, 600), { width: 560, height: 187 })
  assert.deepEqual(previewFitSize(600, 1800), { width: 117, height: 352 })
  assert.deepEqual(previewFitSize(80, 40), { width: 80, height: 40 })
  assert.equal(PREVIEW_MAX_WIDTH, 560)
  assert.equal(PREVIEW_MAX_HEIGHT, 352)
})

test("tiny data URLs keep their source instead of minting a preview blob", () => {
  assert.equal(previewUsesSource(source), true)
  assert.equal(previewNeedsFit(source), false)
  assert.equal(previewUsesSource(`data:image/png;base64,${"A".repeat(PREVIEW_INLINE_PASSTHROUGH_CHARS)}`), false)
  assert.equal(previewNeedsFit(`data:image/png;base64,${"A".repeat(PREVIEW_INLINE_PASSTHROUGH_CHARS)}`), true)
  assert.equal(previewNeedsFit("blob:https://kybern.local/1"), true)
  assert.equal(previewNeedsFit("https://example.com/a.png"), false)
  assert.equal(previewNeedsFit(""), false)
})

test("data URLs become blobs without fetch", async () => {
  const blob = await inlineImageBlob(source)
  assert.equal(blob.type, "image/png")
  assert.ok(blob.size > 0)
})

test("fitImageBlob is a no-op when createImageBitmap is missing", async () => {
  const blob = new Blob(["image"], { type: "image/png" })
  assert.equal(await fitImageBlob(blob, PREVIEW_MAX_WIDTH, PREVIEW_MAX_HEIGHT), blob)
})
