import { createMarkdownQueue, type MarkdownReply } from "./markdownQueue"
import type { ParsedMarkdown } from "./markdownParser"
let worker: Worker | undefined
let consumer = 0
const cache = new Map<string, ParsedMarkdown>()
let cacheBytes = 0
const size = (parsed: ParsedMarkdown) => parsed.source.length * 2 + parsed.blocks.reduce((sum, block) => sum + block.signature.length * 2, 0)
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
  for (const [key, entry] of cache) {
    if (cache.size <= 24 && cacheBytes <= 8 * 1024 * 1024) break
    cache.delete(key); cacheBytes -= size(entry)
  }
}
const queue = createMarkdownQueue((job) => {
  if (!worker) {
    worker = new Worker(new URL("./markdown.worker.ts", import.meta.url), { type: "module" })
    worker.onmessage = (event: MessageEvent<MarkdownReply>) => queue.receive(event.data)
    worker.onerror = (error) => { console.error("Markdown worker failed", error.message, error.filename, error.lineno); queue.dispose(); worker?.terminate(); worker = undefined }
  }
  worker.postMessage(job)
})
export const parseMarkdown = queue.request
export function releaseMarkdown(consumer: number) { worker?.postMessage({ release: consumer }) }
if (import.meta.hot) import.meta.hot.dispose(() => { queue.dispose(); worker?.terminate(); cache.clear() })
