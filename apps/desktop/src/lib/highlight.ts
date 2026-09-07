import { createHighlightQueue, type HighlightReply } from "./highlightQueue"
import { createIdleRelease } from "./idleRelease"
import { shouldHighlightSource } from "./workload"

let worker: Worker | undefined
function makeQueue() {
  return createHighlightQueue((job) => {
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
const idle = createIdleRelease(() => queue.idle(), releaseWorker)

/** Unknown languages, unsupported workers and oversized sources stay readable. */
export function highlightToHtml(code: string, lang: string | null, dark: boolean, options?: { signal?: AbortSignal; live?: boolean }): Promise<string | null> {
  if (!lang || !shouldHighlightSource(code)) return Promise.resolve(null)
  idle.touch()
  return queue.request({ code, lang, dark, cache: !options?.live }, options?.signal).finally(() => idle.settle())
}

if (import.meta.hot) import.meta.hot.dispose(() => {
  idle.dispose()
  queue.dispose()
  worker?.terminate()
})
