import assert from "node:assert/strict"
import test from "node:test"

import { isPreviewOpenTool, previewToolLabel, previewToolName, previewToolRequest } from "../src/previewTool.ts"

test("recognises the tool under any harness spelling", () => {
  assert.equal(isPreviewOpenTool("kybern_preview_open"), true)
  assert.equal(isPreviewOpenTool("mcp__kybern__kybern_preview_open"), true)
  assert.equal(isPreviewOpenTool("kybern_html_preview"), false)
  assert.equal(isPreviewOpenTool("my_kybern_preview_opener"), false)
})

test("reads the request and names the page", () => {
  assert.deepEqual(previewToolRequest({ target: " mockups/index.html ", title: "Home" }), { target: "mockups/index.html", title: "Home" })
  assert.equal(previewToolRequest({ target: "" }), null)
  assert.equal(previewToolRequest(null), null)
  assert.equal(previewToolName({ target: "mockups/index.html" }), "index.html")
  assert.equal(previewToolName({ target: "http://localhost:5173/app" }), "localhost:5173")
  assert.equal(previewToolName({ target: "a.html", title: "Pricing" }), "Pricing")
})

test("labels follow the tense and errors", () => {
  assert.equal(previewToolLabel({ target: "mock/a.html" }, true, false), "Opened preview · a.html")
  assert.equal(previewToolLabel({ target: "mock/a.html" }, false, false), "Opening preview · a.html")
  assert.equal(previewToolLabel({ target: "mock/a.html" }, true, true), "Unable to open preview")
  assert.equal(previewToolLabel(null, true, false), "Opened preview")
})
