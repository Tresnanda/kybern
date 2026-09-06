// Synthetic production-component regression. No daemon or private transcript data.
import { memo, useDeferredValue, useLayoutEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { Markdown } from "../src/components/kybern/Markdown"
import { MessageScroller } from "../src/components/beui/message-scroller"
import { ThemeProviderContext } from "../src/components/theme-context"
import { useSmoothStream } from "../src/lib/hooks"
import "../src/index.css"

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))
const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length * .95)] ?? 0
const fixtureCode = Array.from({ length: 220 }, (_, i) => `const value${i} = { label: "Fixture ${i}", enabled: true };`).join("\n")
const initialText = "```ts\n" + fixtureCode + "\n```\n\nInitial explanation."
const controls: { text: (text: string) => void; live: (live: boolean) => void; smooth: (smooth: boolean) => void } = { text: () => {}, live: () => {}, smooth: () => {} }
export const History = memo(function History() {
  return <>{Array.from({ length: 120 }, (_, i) => <div key={i} data-slot="message" data-from={i % 2 ? "assistant" : "user"}><div data-slot="message-content" data-history-surface>{`History ${i}. ` + "Earlier explanation with preserved text. ".repeat(70)}</div></div>)}</>
})
let historyReads = 0
const originalWalker = document.createTreeWalker.bind(document)
document.createTreeWalker = (...args) => {
  if (args[0] instanceof Element && args[0].hasAttribute("data-history-surface")) historyReads++
  return originalWalker(...args)
}
let revealRenders = 0
export function Demo() {
  const [text, setText] = useState(initialText)
  const [live, setLive] = useState(false)
  const [smooth, setSmooth] = useState(false)
  useLayoutEffect(() => { controls.text = setText; controls.live = setLive; controls.smooth = setSmooth }, [])
  const revealed = useSmoothStream(text, live && smooth)
  const deferred = useDeferredValue(revealed)
  revealRenders++
  return <ThemeProviderContext value={{ theme: "dark", translucent: false, setTheme: () => {}, setTranslucent: () => {} }}>
    <MessageScroller navigation="rail" smooth={false} className="h-screen" followOutput>
      <History />
      <div data-slot="message" data-from="user"><div data-slot="message-content">Review this code</div></div>
      <div id="active-message" data-slot="message" data-from="assistant"><div data-slot="message-content"><Markdown text={smooth && live ? deferred : text} live={live} /></div></div>
    </MessageScroller>
  </ThemeProviderContext>
}

async function run() {
  document.documentElement.classList.add("dark")
  flushSync(() => createRoot(document.getElementById("root")!).render(<Demo />))
  const readyBy = performance.now() + 8000
  while (!document.querySelector(".chat-markdown-codeblock pre.shiki") && performance.now() < readyBy) await sleep(50)
  if (!document.querySelector(".chat-markdown-codeblock pre.shiki")) throw new Error("Syntax highlighter did not become ready")
  const history = document.querySelectorAll<HTMLElement>("[data-history-surface]")
  for (const surface of history) {
    let prototype = Object.getPrototypeOf(surface)
    while (!Object.getOwnPropertyDescriptor(prototype, "textContent")) prototype = Object.getPrototypeOf(prototype)
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "textContent")!
    Object.defineProperty(surface, "textContent", { configurable: true, get() { historyReads++; return descriptor.get!.call(this) }, set(value) { descriptor.set!.call(this, value) } })
  }
  const firstCode = document.querySelector(".chat-markdown-codeblock")!
  ;(firstCode.querySelector('[aria-label="Wrap lines"]') as HTMLElement).click()
  await frame()
  const firstPre = firstCode.querySelector("pre")!
  historyReads = 0
  let retained = 0
  const commits: number[] = []
  for (let i = 0; i < 30; i++) {
    const start = performance.now()
    flushSync(() => controls.text(initialText + " More explanation.".repeat(i + 1)))
    commits.push(performance.now() - start)
    await frame()
    if (document.querySelector(".chat-markdown-codeblock") === firstCode) retained++
  }
  await sleep(100) // Let the rail observer finish its scheduled work after the burst.
  const historyReadsDuringUpdates = historyReads
  const historyCachePass = historyReadsDuringUpdates === 0
  const codeIdentityPass = retained === 30
  const unchangedHighlightPass = firstCode.querySelector("pre") === firstPre && firstCode.isConnected
  const wrapStatePass = document.querySelector(".chat-markdown-codeblock")?.getAttribute("data-wrap") === "true"

  // A large, still-open code fence grows through the real reveal and Markdown path.
  let stream = "```ts\n" + fixtureCode
  flushSync(() => { controls.text(stream); controls.smooth(true) })
  await sleep(100)
  flushSync(() => controls.live(true))
  revealRenders = 0
  let codeMutations = 0
  const observer = new MutationObserver((records) => { codeMutations += records.filter((r) => r.type === "childList" && ((r.target as Element).closest?.(".chat-markdown-codeblock__body") || Array.from(r.addedNodes).some((n) => n instanceof Element && n.matches(".chat-markdown-codeblock")))).length })
  observer.observe(document.getElementById("active-message")!, { childList: true, subtree: true })
  const frames: number[] = []
  const started = performance.now()
  let previous = started
  let lastAppend = started
  while (performance.now() - started < 2200) {
    const now = await frame()
    frames.push(now - previous); previous = now
    if (now - lastAppend >= 90) { stream += `\nconst next${frames.length} = "streamed value";`; controls.text(stream); lastAppend = now }
  }
  const streamRenders = revealRenders
  observer.disconnect()
  const final = stream + "\n```"
  flushSync(() => { controls.text(final); controls.live(false) })
  await sleep(600)
  const finalCode = document.querySelector(".chat-markdown-codeblock__body")?.textContent?.trim()
  const finalTextPass = finalCode === stream.slice(6).trim()
  const viewport = document.querySelector<HTMLElement>('section[aria-label="Conversation"]')!
  const rail = document.querySelector<HTMLElement>('nav[aria-label="Message navigation"]')!
  rail.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }))
  await sleep(100)
  const firstTick = rail.querySelector<HTMLButtonElement>('[data-rail-index="0"]') ?? rail.querySelector<HTMLButtonElement>("button")!
  history[0]!.textContent = "Corrected history"
  await sleep(100)
  // Programmatic focus after a click is not :focus-visible on every WebKit.
  // Exercise the actual hover handler without relying on OS keyboard modality.
  firstTick.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse", pointerId: 1 }))
  await sleep(200)
  const railEditPass = document.querySelector('[data-slot="preview-rail-title"]')?.textContent === "Corrected history"
  firstTick.click()
  await sleep(350)
  const railNavigationPass = viewport.scrollTop < viewport.clientHeight
  rail.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }))
  await sleep(100)
  const ticks = rail.querySelectorAll<HTMLButtonElement>("button")
  ;(rail.querySelector<HTMLButtonElement>('[data-rail-index="121"]') ?? ticks[ticks.length - 1]!).click()
  await sleep(100)
  const followPass = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 60
  viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }))
  viewport.scrollTop = Math.floor((viewport.scrollHeight - viewport.clientHeight) / 2)
  await sleep(100)
  const readingPosition = viewport.scrollTop
  flushSync(() => controls.text(final + "\n\nMore output while reading history."))
  await sleep(150)
  const readingPositionPass = Math.abs(viewport.scrollTop - readingPosition) < 2
  const result = { railEditPass, railNavigationPass, followPass, readingPositionPass, historyElements: history.length, railButtons: document.querySelectorAll('nav[aria-label="Message navigation"] button').length, historyCachePass, historyReadsDuringUpdates, codeIdentityPass, unchangedHighlightPass, wrapStatePass, finalTextPass, retainedCodeBlocks: retained, explanationCommitP95: p95(commits), streamFrames: frames.length, streamFrameP95: p95(frames), streamFramesOver25ms: frames.filter((n) => n > 25).length, streamRenders, codeMutations }
  const highlightBudgetPass = codeMutations >= 2 && codeMutations <= 20
  const revealBudgetPass = streamRenders <= 200
  const pass = railEditPass && railNavigationPass && followPass && readingPositionPass && history.length === 120 && historyCachePass && revealBudgetPass && codeIdentityPass && unchangedHighlightPass && wrapStatePass && finalTextPass && highlightBudgetPass
  document.title = pass ? "Rendering checks passed" : "Rendering checks failed"
  const native = window as unknown as { webkit?: { messageHandlers?: { bench?: { postMessage: (text: string) => void } } } }
  native.webkit?.messageHandlers?.bench?.postMessage(JSON.stringify({ ...result, highlightBudgetPass, revealBudgetPass, pass }))
}
run().catch((error) => {
  const native = window as unknown as { webkit?: { messageHandlers?: { bench?: { postMessage: (text: string) => void } } } }
  native.webkit?.messageHandlers?.bench?.postMessage(JSON.stringify({ pass: false, error: String(error) }))
})
