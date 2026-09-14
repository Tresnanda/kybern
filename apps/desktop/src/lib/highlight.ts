import { createHighlightQueue, type HighlightReply } from "./highlightQueue"
import { createHighlightCache } from "./highlightCache"
import { createIdleRelease } from "./idleRelease"
import { shouldHighlightSource } from "./workload"

let worker: Worker | undefined
// The diagnostic perf runner can set VITE_KYBERN_WORKER_IDLE_MS=2000 to
// compare a short idle release with the shipped 30-second default. Keep the
// settled cache on the renderer side so restarting the worker does not turn a
// revisit into a re-highlight, while the worker itself can release Shiki's
// grammar/runtime allocations.
const configuredIdleMs = Number(import.meta.env?.VITE_KYBERN_WORKER_IDLE_MS)
const workerIdleMs = Number.isFinite(configuredIdleMs) && configuredIdleMs >= 0 ? configuredIdleMs : 30_000
const cache = createHighlightCache()

function makeQueue() {
  return createHighlightQueue((job) => {
    // A settled cache hit that was observed after queueing can avoid waking a
    // released worker. Requests already in flight still finish through the
    // queue, preserving its cancellation and ordering guarantees.
    const cached = cache.get(job.dark, job.lang, job.code)
    if (cached !== undefined) {
      queue.receive({ id: job.id, html: cached })
      return
    }
    if (!worker) {
      const next = new Worker(new URL("./highlight.worker.ts", import.meta.url), { type: "module" })
      worker = next
      next.onmessage = (event: MessageEvent<HighlightReply>) => {
        if (worker !== next) return
        queue.receive(event.data)
        idle.settle()
      }
      next.onerror = () => { if (worker === next) releaseWorker() }
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

/** Unknown languages, unsupported workers and oversized sources stay readable. */
export function highlightToHtml(code: string, lang: string | null, dark: boolean, options?: { signal?: AbortSignal; live?: boolean }): Promise<string | null> {
  if (!lang || !shouldHighlightSource(code)) return Promise.resolve(null)
  if (options?.signal?.aborted) return Promise.resolve(null)
  const cached = cache.get(dark, lang, code)
  if (cached !== undefined) {
    // A renderer-cache hit does not use the worker and must not postpone its
    // pending idle release. This keeps the 2s diagnostic comparison honest.
    return Promise.resolve(cached)
  }
  idle.touch()
  return queue.request({ code, lang, dark, cache: !options?.live }, options?.signal).then((html) => {
    if (html !== null && !options?.live && !options?.signal?.aborted) cache.set({ dark, lang, code, html })
    return html
  }).finally(() => idle.settle())
}

if (import.meta.hot) import.meta.hot.dispose(() => {
  idle.dispose()
  queue.dispose()
  worker?.terminate()
  cache.clear()
})
