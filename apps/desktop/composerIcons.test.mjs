import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import test from "node:test"

// Source modules import siblings without extensions; Node's loader wants them.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier) && context.parentURL?.includes("/src/"))
      return nextResolve(`${specifier}.ts`, context)
    return nextResolve(specifier, context)
  },
})

// Static imports would hoist above the hook, so these load after it.
const { buildStructuredTextParts } = await import("./src/lib/composerTokens.ts")
const { getAttachmentIconName, getFileIconName } = await import("./src/lib/kit/fileIcons.ts")

const call = (name, input) => ({ id: "tool-1", name, input })

test("File icons distinguish common project and attachment types", () => {
  assert.equal(getFileIconName("Cargo.toml"), "rust")
  assert.equal(getFileIconName("src/App.tsx"), "react")
  assert.equal(getFileIconName("docs/RTK.md"), "markdown")
  assert.equal(getFileIconName(".gitignore"), "git")
  assert.equal(getAttachmentIconName({ name: "scan", mimeType: "application/pdf" }), "file-pdf")
})

test("composer preserves spaced skill names as structured provider references", () => {
  const skill = {
    name: "Expo UI SwiftUI",
    path: "/skills/expo-ui-swiftui/SKILL.md",
    scope: "user",
    enabled: true,
  }
  assert.deepEqual(
    buildStructuredTextParts(
      "Use $Expo UI SwiftUI with @src/App.tsx and keep $HOME.",
      new Set(["src/App.tsx"]),
      [skill]
    ),
    [
      { type: "text", text: "Use " },
      { type: "skill", name: "Expo UI SwiftUI", path: skill.path },
      { type: "text", text: " with " },
      { type: "file_mention", path: "src/App.tsx" },
      { type: "text", text: " and keep $HOME." },
    ]
  )
})

test("plugin catalog entries become @ mentions by display name or slug, skills stay $ tokens", () => {
  const computerUse = { name: "computer-use", display_name: "Computer Use", description: "Control Mac apps", path: "plugin://computer-use@openai-bundled", scope: "plugin", enabled: true }
  const review = { name: "review", path: "/skills/review/SKILL.md", scope: "system", enabled: true }
  const mention = { type: "mention", name: "computer-use", path: "plugin://computer-use@openai-bundled", display_name: "Computer Use" }
  assert.deepEqual(buildStructuredTextParts("@Computer Use open Finder and $review it", new Set(), [computerUse, review]), [
    mention,
    { type: "text", text: " open Finder and " },
    { type: "skill", name: "review", path: "/skills/review/SKILL.md" },
    { type: "text", text: " it" },
  ])
  assert.deepEqual(buildStructuredTextParts("Use @computer-use, please", new Set(), [computerUse]), [
    { type: "text", text: "Use " },
    mention,
    { type: "text", text: ", please" },
  ])
  assert.deepEqual(buildStructuredTextParts("@Computer Use", new Set(), [computerUse]), [mention])
  assert.deepEqual(buildStructuredTextParts("email me@computer-use.dev", new Set(), [computerUse]), [{ type: "text", text: "email me@computer-use.dev" }])
})
