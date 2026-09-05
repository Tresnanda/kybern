import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { imageSource, responseImages, imageSafeOutput } from "./src/lib/responseImages.ts"

test("packaged and development CSP allow the remote image schemes accepted by the renderer", () => {
  const config = JSON.parse(readFileSync(new URL("./src-tauri/tauri.conf.json", import.meta.url), "utf8"))
  for (const policy of [config.app.security.csp, config.app.security.devCsp]) {
    const images = policy.split(";").find((rule) => rule.trim().startsWith("img-src ")).trim().split(/\s+/)
    for (const scheme of ["https:", "http:", "data:", "blob:"]) assert.ok(images.includes(scheme), `${scheme} images must work in the packaged app`)
  }
})

test("image URLs retain machine-local paths and reject active or unknown schemes", () => {
  assert.deepEqual(imageSource("screens/first%20pass.png"), { kind: "local", value: "screens/first pass.png" })
  assert.deepEqual(imageSource("file:///workspace/a%20b.png"), { kind: "local", value: "/workspace/a b.png" })
  for (const src of ["javascript:alert(1)", "data:text/html;base64,YQ==", "data:image/svg+xml;base64,YQ==", "file://other/a.png", "//other/a.png", "%zz"]) assert.equal(imageSource(src), null)
})

test("native tool image blocks survive nested harness payloads and deduplicate", () => {
  const blocks = { content: [
    { type: "image", source: { type: "base64", media_type: "image/png", data: "YQ==" } },
    { type: "image", mimeType: "image/png", data: "YQ==" },
    { type: "file", mime: "image/webp", url: "/workspace/result.webp" },
    { type: "imageGeneration", result: "Yg==", outputFormat: "jpeg" },
  ] }
  assert.deepEqual(responseImages(blocks).map((image) => image.source), ["data:image/png;base64,YQ==", "/workspace/result.webp", "data:image/jpeg;base64,Yg=="])
  const safe = JSON.stringify(imageSafeOutput(blocks))
  assert.ok(!safe.includes("YQ==")); assert.ok(!safe.includes("Yg=="))
  assert.ok(safe.includes("/workspace/result.webp"))
})
