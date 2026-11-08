import assert from "node:assert/strict"
import test from "node:test"

const { responseImages, imageSafeOutput, imageSafeValue, imageSource, mediaRef, mediaSource, assetPath } = await import("../src/responseImages.ts")
const { applyEvent, emptyThreadState, seedFromGet } = await import("../src/transcript.ts")
const { toolSurface } = await import("../src/toolSurface.ts")

const HASH = "a".repeat(64)
const MEDIA = { hash: HASH, mime: "image/png", size: 40_000 }
const PNG = "iVBORw0KGgo="

test("a stored image is shown from its owning machine's asset route, never a persisted URL", () => {
  assert.deepEqual(mediaRef({ kybern_media: MEDIA }), MEDIA)
  assert.equal(mediaRef({ kybern_media: { ...MEDIA, hash: "../etc" } }), null)
  assert.equal(mediaRef({ kybern_media: MEDIA, other: 1 }), null)
  assert.equal(mediaSource(MEDIA), `kybern://asset/${HASH}`)
  assert.deepEqual(imageSource(mediaSource(MEDIA)), { kind: "asset", value: `/assets/${HASH}` })
  assert.equal(assetPath("kybern://asset/../../x"), null)
})

test("tool results show inline (old) and referenced (new) images alike", () => {
  const old = [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }]
  const stored = [
    { type: "image", source: { type: "base64", media_type: "image/png", data: { kybern_media: MEDIA } } },
    { type: "input_image", image_url: { kybern_media: { ...MEDIA, encoding: "data_url" } } },
    { file: { base64: { kybern_media: MEDIA }, type: "image/png" } },
  ]
  assert.deepEqual(responseImages(old).map((image) => image.source), [`data:image/png;base64,${PNG}`])
  assert.deepEqual(responseImages(stored).map((image) => image.source), [`kybern://asset/${HASH}`], "the same bytes are one image")
  // A PDF is not an image to show; the text view names it instead of printing the reference.
  const pdf = { type: "document", source: { type: "base64", media_type: "application/pdf", data: { kybern_media: { hash: HASH, mime: "application/pdf", size: 2_048_000 } } } }
  assert.deepEqual(responseImages([pdf]), [])
  assert.equal(imageSafeOutput(pdf).source.data, "[PDF, 2000 KB]")
  assert.equal(JSON.parse(JSON.stringify(stored, imageSafeValue))[0].source.data, "[Image shown above]")
})

test("image events and transcript rows read both shapes", () => {
  let state = emptyThreadState()
  state = applyEvent(state, { seq: 1, turn_id: "t", at: "2026-11-08T00:00:00Z", kind: "image_received", id: "old", origin: { kind: "root" }, source: `data:image/png;base64,${PNG}` })
  state = applyEvent(state, { seq: 2, turn_id: "t", at: "2026-11-08T00:00:01Z", kind: "image_received", id: "new", origin: { kind: "root" }, source: "", media: MEDIA })
  const images = state.blocks.filter((block) => block.kind === "image").map((block) => block.source)
  assert.deepEqual(images, [`data:image/png;base64,${PNG}`, `kybern://asset/${HASH}`])
  const seeded = seedFromGet({
    thread: { id: "th", last_seq: 2 },
    transcript: [
      { role: "image", id: "a", turn_id: "t", seq: 1, at: "2026-11-08T00:00:00Z", origin: { kind: "root" }, source: "https://example.com/a.png" },
      { role: "image", id: "b", turn_id: "t", seq: 2, at: "2026-11-08T00:00:00Z", origin: { kind: "root" }, source: "", media: MEDIA },
    ],
  })
  assert.deepEqual(seeded.blocks.filter((block) => block.kind === "image").map((block) => block.source), ["https://example.com/a.png", `kybern://asset/${HASH}`])
})

test("a stored computer screenshot is still the action's screenshot", () => {
  const call = { id: "c", name: "mcp__computer-use__screenshot", input: {}, parent_id: null }
  const output = { content: [{ type: "image", mimeType: "image/png", data: { kybern_media: MEDIA } }], _meta: { "codex/toolSurface": { kind: "computerUse", app: {} } } }
  const surface = toolSurface(call, output)
  assert.ok(surface, "the call is a computer action")
  assert.deepEqual(surface.screenshots, [`kybern://asset/${HASH}`])
})
