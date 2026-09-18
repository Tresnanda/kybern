import frameScript from "./mermaid.frame.ts?worker&url"
import { createHighlightQueue, type HighlightJob, type HighlightReply } from "./highlightQueue"
import { createIdleRelease } from "./idleRelease"

// Reuse the bounded source-to-markup queue: one active job, cancellation on
// unmount, and no unbounded backlog while the user scrolls through history.
let frame: HTMLIFrameElement | undefined
let ready = false
let pending: HighlightJob | undefined
let deadline: ReturnType<typeof setTimeout> | undefined
const cache = new Map<string, string | null>()
let cacheBytes = 0

function releaseFrame() {
  clearTimeout(deadline)
  frame?.remove()
  frame = undefined
  ready = false
  pending = undefined
  queue.dispose()
  queue = makeQueue()
}
function makeQueue() {
  return createHighlightQueue((job) => {
    pending = job
    // Covers import/render failures too; no waiting consumer is left stranded.
    clearTimeout(deadline)
    deadline = setTimeout(releaseFrame, 10_000)
    if (!frame) {
      frame = document.createElement("iframe")
      frame.title = "Diagram renderer"
      frame.setAttribute("aria-hidden", "true")
      frame.tabIndex = -1
      Object.assign(frame.style, { position: "fixed", left: "-10000px", top: "0", width: "1024px", height: "768px", visibility: "hidden", pointerEvents: "none" })
      document.body.append(frame)
      // This document only runs our bundled renderer, never diagram source as
      // script. Returned SVG is displayed as an inert image in the transcript.
      const script = frame.contentDocument!.createElement("script")
      script.type = "module"
      script.src = new URL(frameScript, document.baseURI).href
      script.onerror = releaseFrame
      frame.contentDocument!.body.append(script)
    } else if (ready) frame.contentWindow?.postMessage(job, "*")
  })
}
let queue = makeQueue()
const idle = createIdleRelease(() => queue.idle(), () => {
  releaseFrame()
  cache.clear()
  cacheBytes = 0
})
function receive(event: MessageEvent<HighlightReply & { mermaid?: boolean; ready?: boolean }>) {
  if (!frame || event.source !== frame.contentWindow || !event.data?.mermaid) return
  if (event.data.ready) {
    ready = true
    if (pending) frame.contentWindow?.postMessage(pending, "*")
    return
  }
  clearTimeout(deadline)
  pending = undefined
  queue.receive(event.data)
  idle.settle()
}
window.addEventListener("message", receive)

export function renderMermaid(code: string, dark: boolean, signal: AbortSignal): Promise<string | null> {
  if (signal.aborted || code.length > 32_768) return Promise.resolve(null)
  const key = `${dark}\0${code}`
  if (cache.has(key)) {
    const svg = cache.get(key)!
    cache.delete(key)
    cache.set(key, svg)
    idle.settle()
    return Promise.resolve(svg)
  }
  idle.touch()
  return queue.request({ code, lang: "mermaid", dark, cache: true }, signal).then((svg) => {
    if (!signal.aborted && !cache.has(key)) {
      const bytes = (key.length + (svg?.length ?? 0)) * 2
      while (cache.size && (cache.size >= 8 || cacheBytes + bytes > 2 * 1024 * 1024)) {
        const [oldKey, oldSvg] = cache.entries().next().value!
        cache.delete(oldKey)
        cacheBytes -= (oldKey.length + (oldSvg?.length ?? 0)) * 2
      }
      cache.set(key, svg)
      cacheBytes += bytes
    }
    return svg
  }).finally(() => idle.settle())
}

/** Drop the nested diagram document immediately. Hidden windows must not wait
 * for the idle timer; the next `renderMermaid` recreates the frame. */
export function releaseMermaidRenderer() {
  idle.dispose()
  cache.clear()
  cacheBytes = 0
  releaseFrame()
}

if (import.meta.hot) import.meta.hot.dispose(() => {
  idle.dispose()
  releaseFrame()
  cache.clear()
  window.removeEventListener("message", receive)
})
