import assert from "node:assert/strict"
import test from "node:test"
import { createMarkdownQueue } from "./src/lib/markdownQueue.ts"

const input = (source) => ({ source, consumer: 1, baseRevision: 0 })
const signal = () => new AbortController().signal

test("Markdown parsing serializes consumers and removes superseded queued prefixes", async () => {
  const sent = []
  const queue = createMarkdownQueue(job => sent.push(job))
  const active = new AbortController()
  const obsolete = new AbortController()
  const first = queue.request(input("first"), active.signal)
  const second = queue.request(input("obsolete"), obsolete.signal)
  const latest = queue.request(input("latest"), signal())
  assert.equal(sent.length, 1)
  obsolete.abort()
  active.abort()
  assert.equal(await first, null)
  assert.equal(await second, null)
  // The worker must finish its already-running job before another is sent.
  assert.equal(sent.length, 1)
  queue.receive({ id: sent[0].id, blocks: "stale" })
  assert.deepEqual(sent.map(job => job.source), ["first", "latest"])
  queue.receive({ id: sent[0].id, blocks: "duplicate" })
  assert.equal(sent.length, 2)
  queue.receive({ id: sent[1].id, blocks: "exact latest" })
  assert.equal((await latest).blocks, "exact latest")
})

test("worker failure releases waiting consumers and falls back to plain text", async () => {
  const queue = createMarkdownQueue(() => { throw new Error("Worker unavailable") })
  assert.equal(await queue.request(input("source"), signal()), null)
  assert.equal(await queue.request(input("another source"), signal()), null)
})

test("Markdown queue bounds memory and does not retain cancelled consumers", async () => {
  const sent = []
  const queue = createMarkdownQueue(job => sent.push(job))
  const abort = new AbortController()
  const requests = Array.from({ length: 64 }, (_, i) => queue.request(input(String(i)), abort.signal))
  assert.equal(await queue.request(input("over capacity"), signal()), null)
  abort.abort()
  assert.deepEqual(await Promise.all(requests), Array(64).fill(null))
  queue.receive({ id: sent[0].id, blocks: null })
  assert.equal(await queue.request(input("x".repeat(4 * 1024 * 1024 + 1)), signal()), null)
  const replacement = queue.request(input("replacement"), signal())
  assert.equal(sent.at(-1).source, "replacement")
  queue.dispose()
  assert.equal(await replacement, null)
  assert.equal(await queue.request(input("closed"), signal()), null)
})
