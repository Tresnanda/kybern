import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const desktop = fileURLToPath(new URL(".", import.meta.url))

test("tall markdown lists and tables are not one leftover paint host", () => {
  const kit = readFileSync(path.join(desktop, "src/styles/kit.css"), "utf8")
  const markdown = readFileSync(path.join(desktop, "src/components/kybern/Markdown.tsx"), "utf8")
  const transcript = readFileSync(path.join(desktop, "src/views/Transcript.tsx"), "utf8")
  const check = readFileSync(path.join(desktop, "scripts/check-rendering.mjs"), "utf8")
  const fixture = readFileSync(path.join(desktop, "perf/live-tool-memory.tsx"), "utf8")

  assert.match(kit, /\.chat-markdown--hosted > \*:not\(ul\):not\(ol\):not\(\.chat-markdown-table\)/)
  assert.match(kit, /\.chat-markdown--hosted li:not\(:has\(> ul, > ol\)\) \{[^}]*will-change:\s*transform/)
  assert.match(kit, /\.chat-markdown--hosted \.chat-markdown-table tr \{[^}]*will-change:\s*transform/)
  assert.doesNotMatch(kit, /\.chat-markdown--hosted > \* \{/)

  assert.match(markdown, /className="chat-markdown-table"/)
  assert.match(transcript, /chat-markdown--hosted/)

  assert.match(check, /VITE_LIVE_TOOLS_PROSE_LAYER/)
  assert.match(check, /KYBERN_PERF_LIVE_PROSE_LAYER/)
  assert.match(fixture, /VITE_LIVE_TOOLS_PROSE_LAYER/)
  assert.match(fixture, /checkProseLayer/)
  assert.match(fixture, /will-change:transform!important/)
})
