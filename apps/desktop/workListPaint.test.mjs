import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const desktop = fileURLToPath(new URL(".", import.meta.url))

test("work-list containers are not compositing layers; nested rows stay hosted", () => {
  const transcript = readFileSync(path.join(desktop, "src/views/Transcript.tsx"), "utf8")
  const vite = readFileSync(path.join(desktop, "perf/vite.config.ts"), "utf8")
  const check = readFileSync(path.join(desktop, "scripts/check-rendering.mjs"), "utf8")

  const lists = [...transcript.matchAll(/data-work-list className="([^"]*)"/g)].map((match) => match[1])
  assert.equal(lists.length, 4, `expected four work-list containers, found ${lists.length}`)
  for (const className of lists) {
    assert.equal(className.includes("chat-paint-host"), false, `work-list container is hosted: ${className}`)
  }

  assert.match(transcript, /data-timeline-row-kind="work"/)
  const liveParent = transcript.match(/data-timeline-row-kind="work"[^>]*>/)
  assert.ok(liveParent)
  assert.doesNotMatch(liveParent[0], /chat-paint-host/)

  assert.match(transcript, /className="chat-paint-host group\/tool-row/)
  assert.match(transcript, /growing list must not become one tiled compositing layer/)

  assert.match(vite, /KYBERN_PERF_LIVE_WORK_LIST_LAYER/)
  assert.match(vite, /data-work-list className="chat-paint-host /)
  assert.match(check, /VITE_LIVE_TOOLS_WORK_LIST_LAYER/)
})
