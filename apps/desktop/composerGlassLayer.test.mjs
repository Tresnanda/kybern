import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const desktop = fileURLToPath(new URL(".", import.meta.url))

test("opaque composer glass does not keep a backdrop stacking context", () => {
  const kybern = readFileSync(path.join(desktop, "src/styles/kybern.css"), "utf8")
  const kit = readFileSync(path.join(desktop, "src/styles/kit.css"), "utf8")
  const check = readFileSync(path.join(desktop, "scripts/check-rendering.mjs"), "utf8")
  const fixture = readFileSync(path.join(desktop, "perf/live-tool-memory.tsx"), "utf8")
  const stack = readFileSync(path.join(desktop, "perf/composer-stack.tsx"), "utf8")
  const material = readFileSync(path.join(desktop, "scripts/check-window-material.swift"), "utf8")

  const before = kit.match(/\.chat-composer-surface::before,\s*\n\.chat-composer-stacked-top::before \{([^}]+)\}/)
  assert.ok(before, "expected composer glass ::before rule")
  assert.match(before[1], /inset:\s*0/)
  assert.match(before[1], /z-index:\s*-1/)
  assert.match(before[1], /-webkit-backdrop-filter:\s*var\(--composer-glass-filter\)/)

  assert.match(kybern, /html\[data-window-material="opaque"\] \.chat-composer-surface::before/)
  const opaque = kybern.match(/html\[data-window-material="opaque"\] \.chat-composer-surface::before,[\s\S]*?\{([^}]+)\}/)
  assert.ok(opaque, "expected opaque composer ::before omit rule")
  assert.match(opaque[1], /content:\s*none/)

  const reduced = kybern.match(/html\[data-window-material\] \.chat-composer-surface::before,[\s\S]*?\{([^}]+)\}/)
  assert.ok(reduced, "expected reduced-transparency composer ::before omit rule")
  assert.match(reduced[1], /content:\s*none/)

  assert.match(check, /VITE_LIVE_TOOLS_COMPOSER_GLASS_LAYER/)
  assert.match(check, /KYBERN_PERF_LIVE_COMPOSER_GLASS_LAYER/)
  assert.match(fixture, /VITE_LIVE_TOOLS_COMPOSER_GLASS_LAYER/)
  assert.match(fixture, /checkComposerGlassLayer/)
  assert.match(fixture, /content:""!important/)
  assert.match(fixture, /data-window-material", "opaque"/)
  assert.match(stack, /no opaque backdrop layer/)
  assert.match(material, /leftover opaque composer backdrop layer/)
})
