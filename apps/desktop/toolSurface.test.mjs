import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import test from "node:test"

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier) && context.parentURL?.includes("/src/"))
      return nextResolve(`${specifier}.ts`, context)
    return nextResolve(specifier, context)
  },
})

const { appDisplayName, surfaceOutputText, toolSurface } = await import("./src/lib/toolSurface.ts")

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
const cua = (code, title = "Step") => ({ id: "call-1", name: "mcp:cua_repl/js", input: { code, title } })
const done = (content, app) => ({ result: { content, structuredContent: null, _meta: { "codex/toolSurface": { kind: "computerUse", app } } }, error: null, status: "completed" })

test("a running screen-control call is recognised from its name and names the app from its code", () => {
  const surface = toolSurface(cua('var app = await cua.getApp("com.apple.finder"); await app.getScreenshot();'))
  assert.deepEqual(surface, { kind: "computer", appId: "com.apple.finder", app: "Finder", screenshots: [] })
  assert.equal(toolSurface({ id: "t", name: "shell", input: { command: "ls" } }), null)
  assert.equal(toolSurface({ id: "t", name: "mcp:github/search", input: {} }), null)
})

test("a settled call takes the app and screenshots from the harness result", () => {
  const output = done([{ type: "image", data: PNG, mimeType: "image/png", _meta: { "codex/imageDetail": "original" } }], { kind: "appId", appId: "com.openai.codex" })
  const surface = toolSurface(cua("await app.getScreenshot();", "Take one screenshot"), output)
  assert.equal(surface.app, "ChatGPT")
  assert.equal(surface.appId, "com.openai.codex")
  assert.deepEqual(surface.screenshots, [`data:image/png;base64,${PNG}`])
  assert.equal(surfaceOutputText(output), "")
  const named = toolSurface(cua("await cua.getState();"), done([], { kind: "displayName", displayName: "Sketch" }))
  assert.equal(named.app, "Sketch")
})

test("text blocks become the readable result and unknown bundle ids still get a name", () => {
  const output = done([{ type: "text", text: "## Computer Use\n\nControl native apps." }, { type: "text", text: '{"apps":[]}' }], null)
  assert.equal(surfaceOutputText(output), '## Computer Use\n\nControl native apps.\n\n{"apps":[]}')
  assert.equal(toolSurface(cua("await cua.getState();"), output).app, null)
  assert.equal(surfaceOutputText({ result: null, error: { message: "Computer Use was not approved to use ChatGPT" }, status: "failed" }), "Computer Use was not approved to use ChatGPT")
  assert.equal(appDisplayName("com.example.my-tool"), "My Tool")
})
