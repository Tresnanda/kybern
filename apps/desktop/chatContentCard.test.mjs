import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const desktop = fileURLToPath(new URL(".", import.meta.url))

test("daily-use chat card does not recreate the measured viewport stacking context", () => {
  const source = readFileSync(path.join(desktop, "src/components/kit/chat/composerPickerStyles.ts"), "utf8")
  const match = source.match(/export const CHAT_CONTENT_CARD_CLASS_NAME = "([^"]+)"/)
  assert.ok(match, "expected CHAT_CONTENT_CARD_CLASS_NAME")
  assert.equal(match[1].includes("z-[15]"), false)
  assert.match(match[1], /chat-content-card/)
  assert.match(match[1], /\brelative\b/)
})

test("chat seam overlay is a 1px strip, not a full-card stacking context", () => {
  const css = readFileSync(path.join(desktop, "src/styles/kit.css"), "utf8")
  const match = css.match(/\.chat-content-card::before \{([^}]+)\}/)
  assert.ok(match, "expected .chat-content-card::before rule")
  const body = match[1]
  assert.match(body, /width:\s*1px/)
  assert.doesNotMatch(body, /inset:\s*0\s*;/)
  assert.match(body, /left:\s*0/)
  assert.match(body, /top:\s*0/)
  assert.match(body, /bottom:\s*0/)
})
