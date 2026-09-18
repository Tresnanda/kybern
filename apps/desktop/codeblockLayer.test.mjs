import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const desktop = fileURLToPath(new URL(".", import.meta.url))

test("tall markdown code is not one leftover paint host", () => {
  const kit = readFileSync(path.join(desktop, "src/styles/kit.css"), "utf8")
  const chunks = readFileSync(path.join(desktop, "src/lib/codeChunks.ts"), "utf8")
  const check = readFileSync(path.join(desktop, "scripts/check-rendering.mjs"), "utf8")
  const fixture = readFileSync(path.join(desktop, "perf/live-tool-memory.tsx"), "utf8")

  const before = kit.match(/\.chat-markdown \.chat-markdown-codeblock::before \{([^}]+)\}/)
  assert.ok(before, "expected codeblock ::before rule")
  assert.match(before[1], /content:\s*none/)
  assert.doesNotMatch(before[1], /will-change:\s*transform/)
  assert.doesNotMatch(before[1], /inset:\s*0/)

  assert.match(kit, /\.chat-markdown--hosted > \*:not\(\.chat-markdown-codeblock\)/)
  assert.match(kit, /\.chat-markdown \.chat-markdown-codeblock__header \{[^}]*will-change:\s*transform/)
  assert.match(kit, /\.chat-code-chunk \{[^}]*will-change:\s*transform/)
  assert.match(kit, /\.chat-code-chunk \{[^}]*background:\s*var\(--app-chat-code-surface\)/)
  assert.match(kit, /\.chat-markdown-codeblock__body:not\(:has\(\.chat-code-chunk\)\) \{[^}]*will-change:\s*transform/)
  assert.match(kit, /\.chat-markdown-codeblock__body:has\(\.chat-code-chunk\) pre/)
  assert.match(kit, /\.chat-code-chunk:first-child \{[^}]*padding-top:\s*0\.5rem/)
  assert.match(kit, /\.chat-code-chunk:last-child \{[^}]*padding-bottom:\s*0\.5rem/)

  assert.match(chunks, /CODE_CHUNK_LINES = 40/)
  assert.match(chunks, /chat-code-chunk/)

  assert.match(check, /VITE_LIVE_TOOLS_CODEBLOCK_LAYER/)
  assert.match(check, /KYBERN_PERF_LIVE_CODEBLOCK_LAYER/)
  assert.match(fixture, /VITE_LIVE_TOOLS_CODEBLOCK_LAYER/)
  assert.match(fixture, /checkCodeblockLayer/)
  assert.match(fixture, /will-change:transform!important/)
})
