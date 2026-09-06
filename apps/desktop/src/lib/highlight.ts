import { createHighlightQueue, type HighlightReply } from "./highlightQueue"
import { shouldHighlightSource } from "./workload"

let worker: Worker | undefined
const queue = createHighlightQueue((job) => {
  if (!worker) {
    worker = new Worker(new URL("./highlight.worker.ts", import.meta.url), { type: "module" })
    worker.onmessage = (event: MessageEvent<HighlightReply>) => queue.receive(event.data)
    worker.onerror = () => {
      queue.dispose()
      worker?.terminate()
      worker = undefined
    }
  }
  worker.postMessage(job)
})

/** Unknown languages, unsupported workers and oversized sources stay readable. */
export function highlightToHtml(code: string, lang: string | null, dark: boolean, options?: { signal?: AbortSignal; live?: boolean }): Promise<string | null> {
  if (!lang || !shouldHighlightSource(code)) return Promise.resolve(null)
  return queue.request({ code, lang, dark, cache: !options?.live }, options?.signal)
}

if (import.meta.hot) import.meta.hot.dispose(() => {
  queue.dispose()
  worker?.terminate()
})
