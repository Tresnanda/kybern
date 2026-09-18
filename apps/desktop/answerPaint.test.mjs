import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const desktop = fileURLToPath(new URL(".", import.meta.url))

test("assistant answers are not compositing layers; nested markdown stays hosted", () => {
  const transcript = readFileSync(path.join(desktop, "src/views/Transcript.tsx"), "utf8")
  const kit = readFileSync(path.join(desktop, "src/styles/kit.css"), "utf8")
  const vite = readFileSync(path.join(desktop, "perf/vite.config.ts"), "utf8")
  const check = readFileSync(path.join(desktop, "scripts/check-rendering.mjs"), "utf8")
  const fixture = readFileSync(path.join(desktop, "perf/live-tool-memory.tsx"), "utf8")

  const host = transcript.match(/data-answer-host className="([^"]*)"/)
  assert.ok(host, "expected data-answer-host wrapper")
  assert.equal(host[1].includes("chat-paint-host"), false, `answer container is hosted: ${host[1]}`)

  const content = transcript.match(/group\.answer && \(\s*<div data-slot="message-content"([^>]*)>/)
  assert.ok(content, "expected assistant message-content")
  assert.doesNotMatch(content[1], /chat-paint-host/)

  assert.match(transcript, /className="chat-markdown--hosted"/)
  assert.match(transcript, /data-response-images className="chat-paint-host"/)
  assert.match(transcript, /className="chat-paint-host mt-0.5 flex items-center gap-2/)

  assert.match(kit, /\.chat-markdown--hosted > \*/)
  assert.match(kit, /will-change:\s*transform/)

  assert.match(vite, /KYBERN_PERF_LIVE_ANSWER_LAYER/)
  assert.match(vite, /data-answer-host className="chat-paint-host /)
  assert.match(check, /VITE_LIVE_TOOLS_ANSWER_LAYER/)
  assert.match(fixture, /checkAnswerHosts/)
})
