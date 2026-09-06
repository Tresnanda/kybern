// Large synthetic workloads using the actual Transcript, store and Markdown.
import { useState, useLayoutEffect } from "react"
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { Transcript } from "../src/views/Transcript"
import { Markdown } from "../src/components/kybern/Markdown"
import { useSmoothStream } from "../src/lib/hooks"
import { useStore } from "../src/state/store"
import { emptyThreadState, type Block } from "../src/state/transcript"
import { ThemeProviderContext } from "../src/components/theme-context"
import "../src/index.css"

const HISTORY = 400
const TOOLS = 800
const AT = "2026-09-01T12:00:00Z"
const origin = { kind: "root" } as const
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))
const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length * .95)] ?? 0
const paragraph = "A stable interface preserves **important details** while new information arrives. Keep [navigation](https://example.com) available and render `inline code` without disrupting the reader."
const answer = Array.from({ length: 8 }, (_, i) => `### Detail ${i}

${paragraph}

- First item
- Second item
`).join("\n")
let seq = 0
function user(turnId: string, text: string): Block { return { kind: "user", id: `user-${turnId}`, turnId, at: AT, seq: ++seq, message: { parts: [{ type: "text", text }] } } }
function assistant(turnId: string, text: string): Block { return { kind: "assistant", id: `answer-${turnId}`, messageId: `answer-${turnId}`, segment: 0, turnId, at: AT, seq: ++seq, text, thinking: "", complete: true, origin } }
function end(turnId: string): Block { return { kind: "turn_end", id: `end-${turnId}`, turnId, at: AT, seq: ++seq, stopReason: "completed", usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, costUsd: null, durationMs: 1200, terminalMessageId: `answer-${turnId}`, error: null } }
const history: Block[] = Array.from({ length: HISTORY }, (_, i) => [user(`turn-${i}`, `Question ${i}: explain the implementation`), assistant(`turn-${i}`, answer), end(`turn-${i}`)]).flat()
const heavy: Block[] = [user("heavy", "Read the project files"), ...Array.from({ length: TOOLS }, (_, i): Block => ({ kind: "tool", id: `tool-${i}`, turnId: "heavy", at: AT, seq: ++seq, origin, call: { id: `tool-${i}`, name: "Read", input: { file_path: `/project/src/file-${i}.ts` }, parent_id: null }, stream: "", output: `const value = ${i};\nexport default value;`, isError: false, complete: true })), assistant("heavy", "Finished reading the project files."), end("heavy")]
const actions: { mode: (value: "history" | "stream") => void; text: (value: string) => void; live: (value: boolean) => void } = { mode: () => {}, text: () => {}, live: () => {} }
const streamStart = Array.from({ length: 180 }, (_, i) => `## Section ${i}

${paragraph}

| Name | Value |
| --- | --- |
| alpha | ${i} |

`).join("")
let inputEvents = 0
export function Demo() {
  const [mode, setMode] = useState<"history" | "stream">("history")
  const [text, setText] = useState(streamStart)
  const [live, setLive] = useState(false)
  const shown = useSmoothStream(text, live)
  useLayoutEffect(() => { actions.mode = setMode; actions.text = setText; actions.live = setLive }, [])
  return <ThemeProviderContext value={{ theme: "dark", translucent: false, setTheme: () => {}, setTranslucent: () => {} }}>
    <div className="flex h-screen flex-col">
      <input id="typing-probe" aria-label="Typing probe" onInput={() => { inputEvents++ }} style={{ height: 32, flexShrink: 0 }} />
      {mode === "history" ? <Transcript threadId="fixture" bottomInset={0} /> : <div id="stream-viewport" className="flex-1 overflow-auto"><Markdown text={shown} live={live} /></div>}
    </div>
  </ThemeProviderContext>
}

function stage(value: string) {
  const native = window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }
  native.webkit.messageHandlers.bench.postMessage(JSON.stringify({ stage: value, at: performance.now() }))
}
async function run() {
  document.documentElement.classList.add("dark")
  useStore.getState().set({ transcripts: { fixture: { ...emptyThreadState(), loaded: true, blocks: [...history, ...heavy] } } })
  const start = performance.now()
  flushSync(() => createRoot(document.getElementById("root")!).render(<Demo />))
  stage("mounted")
  const mountMs = performance.now() - start
  await sleep(300)
  const viewport = document.querySelector<HTMLElement>("[data-chat-scroll-container]")!
  stage("history ready")
  const historyMessages = document.querySelectorAll('[data-slot="message"]').length
  const historyNodes = document.querySelectorAll("*").length
  let messageRects = 0
  const rect = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function() {
    if (this.matches('[data-slot="message"]')) messageRects++
    return rect.call(this)
  }
  const scrollFrames: number[] = []
  let previous = await frame()
  for (let i = 0; i < 90; i++) {
    if (i % 15 === 0) stage("scroll " + i)
    viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }))
    viewport.scrollTop = (viewport.scrollHeight - viewport.clientHeight) * (.05 + .9 * i / 89)
    const now = await frame(); scrollFrames.push(now - previous); previous = now
  }
  Element.prototype.getBoundingClientRect = rect
  document.querySelector<HTMLButtonElement>('[aria-label="Scroll to bottom"]')!.click()
  await sleep(180)
  stage("expand work")
  const expandStart = performance.now()
  flushSync(() => useStore.getState().toggleWork("heavy"))
  const expandMs = performance.now() - expandStart
  await sleep(300)
  const grouped = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((el) => /Read 800/.test(el.textContent ?? ""))

  grouped?.click()
  await sleep(300)
  const workRows = document.querySelectorAll("[data-work-entry-display-text]").length
  const expandedNodes = document.querySelectorAll("*").length
  stage("before stream")
  flushSync(() => actions.mode("stream"))
  await sleep(200)
  stage("starting stream")
  flushSync(() => actions.live(true))
  let text = streamStart
  const streamFrames: number[] = []
  const inputDelay: number[] = []
  let inputTicks = 0
  const input = document.getElementById("typing-probe") as HTMLInputElement
  const typing = setInterval(() => {
    const requested = performance.now()
    input.value += "x"
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "x", inputType: "insertText" }))
    requestAnimationFrame(() => inputDelay.push(performance.now() - requested))
    inputTicks++
  }, 80)
  const streamAt = performance.now()
  previous = await frame()
  let appendAt = streamAt
  while (performance.now() - streamAt < 2300) {
    const now = await frame(); streamFrames.push(now - previous); previous = now
    if (now - appendAt >= 60) { text += " More **streamed** text with `code`."; actions.text(text); appendAt = now }
  }
  clearInterval(typing)
  const finalAt = performance.now()
  flushSync(() => { actions.text(text + " FINAL_MARKER"); actions.live(false) })
  const finalCommitMs = performance.now() - finalAt
  for (let attempt = 0; attempt < 100 && !document.getElementById("stream-viewport")?.textContent?.endsWith("FINAL_MARKER"); attempt++) await sleep(20)
  const finalPass = document.getElementById("stream-viewport")?.textContent?.endsWith("FINAL_MARKER") === true && document.querySelectorAll("#stream-viewport table").length === 180
  const result = { historyTurns: HISTORY + 1, mountMs, historyMessages, historyNodes, messageRects, scrollFrameP95: p95(scrollFrames), scrollFramesOver25ms: scrollFrames.filter((value) => value > 25).length, expandMs, grouped: !!grouped, workRows, expandedNodes, streamChars: text.length, streamFrames: streamFrames.length, streamFrameP95: p95(streamFrames), streamFramesOver25ms: streamFrames.filter((value) => value > 25).length, inputTicks, inputEvents, inputFrameP95: p95(inputDelay), finalCommitMs, finalPass }
  const responsivenessPass = p95(streamFrames) < 50 && p95(inputDelay) < 50 && inputEvents === inputTicks && inputEvents >= 20 && finalCommitMs < 30
  const pass = responsivenessPass && historyMessages > 0 && historyMessages < 100 && !!grouped && workRows > 0 && workRows < 160 && messageRects < 5000 && finalPass
  const native = window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }
  native.webkit.messageHandlers.bench.postMessage(JSON.stringify({ ...result, responsivenessPass, pass }))
}
run().catch((error) => {
  const native = window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }
  native.webkit.messageHandlers.bench.postMessage(JSON.stringify({ pass: false, error: String(error) }))
})
