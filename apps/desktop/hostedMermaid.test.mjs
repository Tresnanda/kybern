import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const desktop = fileURLToPath(new URL(".", import.meta.url))

test("tall mermaid diagrams are not one leftover paint host", () => {
  const kit = readFileSync(path.join(desktop, "src/styles/kit.css"), "utf8")
  const mermaid = readFileSync(path.join(desktop, "src/components/kybern/MermaidBlock.tsx"), "utf8")
  const transcript = readFileSync(path.join(desktop, "src/views/Transcript.tsx"), "utf8")
  const check = readFileSync(path.join(desktop, "scripts/check-rendering.mjs"), "utf8")
  const fixture = readFileSync(path.join(desktop, "perf/live-tool-memory.tsx"), "utf8")

  assert.match(kit, /\.chat-markdown--hosted > \*:not\(\.chat-mermaid\)/)
  assert.match(kit, /\.chat-markdown--hosted > \.chat-mermaid \.chat-diagram-canvas > img \{[^}]*will-change:\s*transform/)
  assert.match(kit, /\.chat-markdown--hosted > \.chat-mermaid \.chat-diagram-note \{[^}]*will-change:\s*transform/)
  assert.match(kit, /\.chat-diagram-canvas > img \{[^}]*max-height:\s*24rem/)
  assert.doesNotMatch(kit, /\.chat-markdown--hosted > \* \{/)
  assert.doesNotMatch(kit, /\.chat-markdown--hosted > \.chat-mermaid \{[^}]*will-change:\s*transform/)
  assert.doesNotMatch(kit, /\.chat-diagram-canvas \{[^}]*will-change:\s*transform/)

  assert.match(mermaid, /className="chat-mermaid"/)
  assert.match(mermaid, /className="chat-diagram-canvas"/)
  assert.match(transcript, /chat-markdown--hosted/)

  assert.match(check, /VITE_LIVE_TOOLS_MERMAID_LAYER/)
  assert.match(check, /KYBERN_PERF_LIVE_MERMAID_LAYER/)
  assert.match(fixture, /VITE_LIVE_TOOLS_MERMAID_LAYER/)
  assert.match(fixture, /checkMermaidLayer/)
  assert.match(fixture, /will-change:transform!important/)
})
