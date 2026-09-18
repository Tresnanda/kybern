import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const desktop = fileURLToPath(new URL(".", import.meta.url))

test("transcript turns are not compositing layers; nested work rows stay hosted", () => {
  const transcript = readFileSync(path.join(desktop, "src/views/Transcript.tsx"), "utf8")
  const virtual = readFileSync(path.join(desktop, "src/components/kybern/VirtualRows.tsx"), "utf8")
  const activity = readFileSync(path.join(desktop, "src/views/Activity.tsx"), "utf8")
  const vite = readFileSync(path.join(desktop, "perf/vite.config.ts"), "utf8")
  const check = readFileSync(path.join(desktop, "scripts/check-rendering.mjs"), "utf8")

  const turnList = transcript.match(/<VirtualRows items=\{groups\}([^>]*)>/)
  assert.ok(turnList, "expected transcript group VirtualRows")
  assert.match(turnList[1], /paintHost=\{false\}/)

  const calls = [...transcript.matchAll(/<VirtualRows\b([^>]*)>/g)].map((match) => match[1])
  assert.ok(calls.length >= 3, `expected nested work VirtualRows, found ${calls.length}`)
  for (const attrs of calls.filter((value) => !value.includes("items={groups}"))) {
    assert.doesNotMatch(attrs, /paintHost=\{false\}/, `nested VirtualRows lost its paint host: ${attrs}`)
  }
  assert.doesNotMatch(activity, /paintHost=\{false\}/)

  assert.match(virtual, /paintHost = true/)
  assert.match(virtual, /willChange: paintHost \? "transform" : undefined/)
  assert.match(virtual, /contain: paintHost && items\.length > 30 \? "paint" : undefined/)
  assert.match(virtual, /className=\{paintHost \? "chat-paint-host" : undefined\}/)
  assert.match(virtual, /data-virtual-paint=\{paintHost \? "host" : "flow"\}/)

  assert.match(vite, /KYBERN_PERF_LIVE_TURN_LAYER/)
  assert.match(vite, /paintHost=\{false\}/)
  assert.match(vite, /paintHost=\{true\}/)
  assert.match(check, /VITE_LIVE_TOOLS_TURN_LAYER/)
})
