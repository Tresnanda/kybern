import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const desktop = fileURLToPath(new URL(".", import.meta.url))

test("inline edited-files cards are not one leftover paint host", () => {
  const transcript = readFileSync(path.join(desktop, "src/views/Transcript.tsx"), "utf8")
  const diffView = readFileSync(path.join(desktop, "src/components/kybern/DiffView.tsx"), "utf8")
  const kit = readFileSync(path.join(desktop, "src/styles/kit.css"), "utf8")
  const check = readFileSync(path.join(desktop, "scripts/check-rendering.mjs"), "utf8")
  const fixture = readFileSync(path.join(desktop, "perf/live-tool-memory.tsx"), "utf8")

  assert.match(transcript, /data-edited-files className="/)
  const card = transcript.match(/data-edited-files className="([^"]*)"/)
  assert.ok(card, "expected data-edited-files wrapper")
  assert.equal(card[1].includes("chat-paint-host"), false, `edited-files card is hosted: ${card[1]}`)
  assert.match(transcript, /chat-paint-host flex items-center justify-between gap-3/)
  assert.match(transcript, /data-edited-file-row[\s\S]*?className="chat-paint-host flex w-full/)

  assert.match(diffView, /<tr className=\{cn\("chat-paint-host"/)
  assert.match(diffView, /<tr key=\{i\} className=\{cn\("chat-paint-host"/)
  assert.match(diffView, /DIFF_LINES_BATCH = 600/)

  assert.match(kit, /\.chat-paint-host \{[^}]*will-change:\s*transform/)
  assert.match(kit, /edited-files-layer-2026-09-18/)

  assert.match(check, /VITE_LIVE_TOOLS_EDITED_FILES_LAYER/)
  assert.match(check, /KYBERN_PERF_LIVE_EDITED_FILES_LAYER/)
  assert.match(fixture, /VITE_LIVE_TOOLS_EDITED_FILES_LAYER/)
  assert.match(fixture, /checkEditedFilesLayer/)
  assert.match(fixture, /\[data-edited-files\]\{will-change:transform!important\}/)
})
