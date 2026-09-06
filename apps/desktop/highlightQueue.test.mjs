import assert from "node:assert/strict"
import test from "node:test"
import { createHighlightQueue } from "./src/lib/highlightQueue.ts"

const input = (code) => ({ code, lang: "typescript", dark: true, cache: false })

test("highlighting serializes consumers and removes superseded queued prefixes", async () => {
  const sent = []
  const queue = createHighlightQueue(job => sent.push(job))
  const active = new AbortController()
  const obsolete = new AbortController()
  const first = queue.request(input("first"), active.signal)
  const second = queue.request(input("obsolete"), obsolete.signal)
  const latest = queue.request(input("latest"))
  assert.equal(sent.length, 1)
  obsolete.abort()
  active.abort()
  assert.equal(await first, null)
  assert.equal(await second, null)
  // The worker must finish its already-running job before another is sent.
  assert.equal(sent.length, 1)
  queue.receive({ id: sent[0].id, html: "stale" })
  assert.deepEqual(sent.map(job => job.code), ["first", "latest"])
  queue.receive({ id: sent[0].id, html: "duplicate" })
  assert.equal(sent.length, 2)
  queue.receive({ id: sent[1].id, html: "exact latest" })
  assert.equal(await latest, "exact latest")
})

test("worker failure releases waiting consumers and falls back to plain text", async () => {
  const queue = createHighlightQueue(() => { throw new Error("Worker unavailable") })
  assert.equal(await queue.request(input("source")), null)
  assert.equal(await queue.request(input("another source")), null)
})

test("highlight queue bounds memory and does not retain cancelled consumers", async () => {
  const sent = []
  const queue = createHighlightQueue(job => sent.push(job))
  const abort = new AbortController()
  const requests = Array.from({ length: 64 }, (_, i) => queue.request(input(String(i)), abort.signal))
  assert.equal(await queue.request(input("over capacity")), null)
  abort.abort()
  assert.deepEqual(await Promise.all(requests), Array(64).fill(null))
  queue.receive({ id: sent[0].id, html: null })
  assert.equal(await queue.request(input("x".repeat(2 * 1024 * 1024 + 1))), null)
  const replacement = queue.request(input("replacement"))
  assert.equal(sent.at(-1).code, "replacement")
  queue.dispose()
  assert.equal(await replacement, null)
  assert.equal(await queue.request(input("closed")), null)
})
