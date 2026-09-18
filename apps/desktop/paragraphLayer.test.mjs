import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const desktop = fileURLToPath(new URL(".", import.meta.url))

test("tall hosted paragraphs are not one leftover paint host", () => {
  const kit = readFileSync(path.join(desktop, "src/styles/kit.css"), "utf8")
  const markdown = readFileSync(path.join(desktop, "src/components/kybern/Markdown.tsx"), "utf8")
  const chunks = readFileSync(path.join(desktop, "src/lib/proseChunks.ts"), "utf8")
  const check = readFileSync(path.join(desktop, "scripts/check-rendering.mjs"), "utf8")
  const fixture = readFileSync(path.join(desktop, "perf/live-tool-memory.tsx"), "utf8")

  assert.match(
    kit,
    /\.chat-markdown--hosted > \*:not\(p\):not\(h1\):not\(h2\):not\(h3\):not\(h4\):not\(h5\):not\(h6\):not\(hr\)/,
  )
  assert.doesNotMatch(kit, /\.chat-markdown--hosted > \* \{/)
  assert.match(kit, /\.chat-markdown--hosted \.chat-prose-chunk \{[^}]*will-change:\s*transform/)
  assert.match(kit, /\.chat-markdown--hosted > hr \{[^}]*will-change:\s*transform/)

  assert.match(markdown, /className="chat-prose-chunk"/)
  assert.match(markdown, /chunkProseText/)
  assert.match(markdown, /markdownHostsProse/)
  assert.match(markdown, /hosted \? renderProseChunks\(content\) : content/)
  assert.match(markdown, /LIVE_COMPONENTS = \{ \.\.\.BASE_COMPONENTS, \.\.\.LIVE_TEXT_COMPONENTS \}/)
  assert.match(chunks, /PROSE_CHUNK_CHARS = 1600/)
  assert.match(kit, /\.chat-markdown--hosted \.chat-prose-chunk \{[^}]*display:\s*block/)
  assert.match(kit, /\.chat-markdown--hosted \.chat-prose-chunk \{[^}]*white-space:\s*pre-wrap/)

  assert.match(check, /VITE_LIVE_TOOLS_PARAGRAPH_LAYER/)
  assert.match(check, /KYBERN_PERF_LIVE_PARAGRAPH_LAYER/)
  assert.match(fixture, /VITE_LIVE_TOOLS_PARAGRAPH_LAYER/)
  assert.match(fixture, /checkParagraphLayer/)
  assert.match(fixture, /will-change:transform!important/)
})

test("user and non-hosted paragraphs are not wrapped in prose chunks", () => {
  const markdown = readFileSync(path.join(desktop, "src/components/kybern/Markdown.tsx"), "utf8")
  const chunks = readFileSync(path.join(desktop, "src/lib/proseChunks.ts"), "utf8")
  const transcript = readFileSync(path.join(desktop, "src/views/Transcript.tsx"), "utf8")
  const chatFixes = readFileSync(path.join(desktop, "perf/chat-fixes.tsx"), "utf8")

  assert.match(chunks, /export function markdownHostsProse/)
  assert.match(markdown, /MarkdownHostedContext value=\{markdownHostsProse\(className\)\}/)
  assert.match(markdown, /hosted \? renderProseChunks\(content\) : content/)
  assert.match(transcript, /<Markdown text=\{text\} variant="user" style=\{TEXT\} tokens=\{tokens\} \/>/)
  assert.doesNotMatch(transcript, /variant="user"[^>]*chat-markdown--hosted/)
  assert.match(chatFixes, /const text = paragraph\.firstChild!/)
  assert.match(chatFixes, /first\.setStart\(text, 0\); first\.setEnd\(text, 5\)/)
  assert.match(chatFixes, /second\.setStart\(text, 11\); second\.setEnd\(text, 17\)/)
})
