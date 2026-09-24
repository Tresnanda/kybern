import { createIdleRelease } from "./idleRelease"
import { retainedSize } from "./retainedSize"
import { createMarkdownQueue, type MarkdownInput, type MarkdownReply } from "./markdownQueue"
import type { ParsedMarkdown } from "./markdownParser"
let worker: Worker | undefined
let consumer = 0
const cache = new Map<string, ParsedMarkdown>()
let cacheBytes = 0
const size = retainedSize
// Release parser sessions and worker module state after a short idle while
// preserving the bounded renderer-owned settled cache. The build override is
// retained for matched native lifetime comparisons.
const configuredIdleMs = Number(import.meta.env?.VITE_KYBERN_WORKER_IDLE_MS)
const workerIdleMs = Number.isFinite(configuredIdleMs) && configuredIdleMs >= 0 ? configuredIdleMs : 2_000

export const nextMarkdownConsumer = () => ++consumer
export function cachedMarkdown(source: string) {
  const parsed = cache.get(source)
  if (parsed) { cache.delete(source); cache.set(source, parsed) }
  return parsed
}
export function cacheMarkdown(parsed: ParsedMarkdown) {
  if (cache.has(parsed.source)) return
  const bytes = size(parsed)
  if (bytes > 8 * 1024 * 1024) return
  cache.set(parsed.source, parsed)
  cacheBytes += bytes
  idle.settle()
  for (const [key, entry] of cache) {
    if (cache.size <= 24 && cacheBytes <= 8 * 1024 * 1024) break
    cache.delete(key); cacheBytes -= size(entry)
  }
}
function makeQueue() {
  return createMarkdownQueue((job) => {
    if (!worker) {
      const next = new Worker(new URL("./markdown.worker.ts", import.meta.url), { type: "module" })
      worker = next
      next.onmessage = (event: MessageEvent<MarkdownReply>) => {
        if (worker !== next) return
        queue.receive(event.data)
        idle.settle()
      }
      next.onerror = (error) => {
        if (worker !== next) return
        console.error("Markdown worker failed", error.message)
        releaseWorker()
      }
    }
    worker.postMessage(job)
  })
}
let queue = makeQueue()
function releaseWorker() {
  worker?.terminate()
  worker = undefined
  queue.dispose()
  queue = makeQueue()
}
const idle = createIdleRelease(() => queue.idle(), releaseWorker, workerIdleMs)
export function parseMarkdown(input: MarkdownInput, signal: AbortSignal) {
  idle.touch()
  return queue.request(input, signal).finally(() => idle.settle())
}
export function releaseMarkdown(consumer: number) { worker?.postMessage({ release: consumer }); idle.settle() }
/** Drop parsed Markdown trees when a hidden window releases its transcript. */
export function releaseMarkdownCaches() {
  cache.clear()
  cacheBytes = 0
  idle.settle()
}
if (import.meta.hot) import.meta.hot.dispose(() => { idle.dispose(); queue.dispose(); worker?.terminate(); cache.clear(); cacheBytes = 0 })
