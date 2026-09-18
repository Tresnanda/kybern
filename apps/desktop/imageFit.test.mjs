import assert from "node:assert/strict"
import test from "node:test"
import {
  fitImageBlob,
  inlineImageBlob,
  thumbnailFitSize,
  thumbnailUsesSource,
  THUMBNAIL_INLINE_PASSTHROUGH_CHARS,
  THUMBNAIL_MAX_EDGE,
} from "./src/lib/imageFit.ts"

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="
const source = `data:image/png;base64,${png}`

test("thumbnail fit never upscales and matches the 64px chip at 2×", () => {
  assert.deepEqual(thumbnailFitSize(4000, 3000), { width: 128, height: 96 })
  assert.deepEqual(thumbnailFitSize(3000, 4000), { width: 96, height: 128 })
  assert.deepEqual(thumbnailFitSize(64, 64), { width: 64, height: 64 })
  assert.deepEqual(thumbnailFitSize(1, 1), { width: 1, height: 1 })
  assert.equal(THUMBNAIL_MAX_EDGE, 128)
})

test("tiny data URLs keep their source instead of minting a preview blob", () => {
  assert.equal(thumbnailUsesSource(source), true)
  assert.equal(thumbnailUsesSource(`data:image/png;base64,${"A".repeat(THUMBNAIL_INLINE_PASSTHROUGH_CHARS)}`), false)
  assert.equal(thumbnailUsesSource("blob:https://kybern.local/1"), false)
})

test("data URLs become blobs without fetch", async () => {
  const blob = await inlineImageBlob(source)
  assert.equal(blob.type, "image/png")
  assert.ok(blob.size > 0)
})

test("fitImageBlob is a no-op when createImageBitmap is missing", async () => {
  const blob = new Blob(["image"], { type: "image/png" })
  assert.equal(await fitImageBlob(blob, THUMBNAIL_MAX_EDGE, THUMBNAIL_MAX_EDGE), blob)
})
