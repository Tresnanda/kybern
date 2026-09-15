import assert from "node:assert/strict"
import test from "node:test"
import { createHighlightCache } from "./src/lib/highlightCache.ts"

const value = (code, html = `<span>${code}</span>`) => ({ dark: true, lang: "typescript", code, html })

test("highlight cache replaces overlapping same-source misses without duplicate LRU entries", () => {
  const cache = createHighlightCache({ maxBytes: 10_000, maxEntries: 4 })
  cache.set(value("same", "old"))
  cache.set(value("same", "new"))
  assert.equal(cache.get(true, "typescript", "same"), "new")
  assert.equal(cache.size, 1)
  assert.equal(cache.bytes, ("typescript".length + "same".length + "new".length) * 2)
})

test("highlight cache evicts the least recently used settled output", () => {
  const cache = createHighlightCache({ maxBytes: 10_000, maxEntries: 2 })
  cache.set(value("first"))
  cache.set(value("second"))
  assert.equal(cache.get(true, "typescript", "first")?.includes("first"), true)
  cache.set(value("third"))
  assert.equal(cache.get(true, "typescript", "first")?.includes("first"), true)
  assert.equal(cache.get(true, "typescript", "second"), undefined)
  assert.equal(cache.get(true, "typescript", "third")?.includes("third"), true)
  assert.equal(cache.size, 2)
})

test("highlight cache keeps theme and grammar namespaces independent", () => {
  const cache = createHighlightCache({ maxBytes: 10_000, maxEntries: 4 })
  cache.set(value("same", "dark"))
  cache.set({ ...value("same", "light"), dark: false, lang: "javascript" })
  assert.equal(cache.get(true, "typescript", "same"), "dark")
  assert.equal(cache.get(false, "javascript", "same"), "light")
  assert.equal(cache.size, 2)
})
