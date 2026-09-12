// Scroll frames through the actual transcript, both settled and receiving work.
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { Transcript } from "../src/views/Transcript"
import { useStore } from "../src/state/store"
import { emptyThreadState, type Block } from "../src/state/transcript"
import { ThemeProviderContext } from "../src/components/theme-context"
import "../src/index.css"

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const frame = () => new Promise<number>(resolve => requestAnimationFrame(resolve))
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * .95)] ?? 0
const at = "2026-09-01T12:00:00Z", origin = { kind: "root" } as const
let seq = 0
const base = (id: string, turnId: string) => ({ id, turnId, at, seq: ++seq })
const user = (id: string): Block => ({ ...base(`user-${id}`, id), kind: "user", message: { parts: [{ type: "text", text: `Inspect ${id}` }] } })
const answer = (id: string, text: string, complete = true, thinking = ""): Block => ({ ...base(id, id.split(":")[0]!), kind: "assistant", messageId: id, segment: 0, origin, thinking, text, complete })
const end = (id: string): Block => ({ ...base(`end-${id}`, id), kind: "turn_end", stopReason: "completed", usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, costUsd: null, durationMs: 1000, terminalMessageId: `${id}:answer`, error: null })
const tool = (i: number): Block => ({ ...base(`tool-${i}`, "work"), kind: "tool", origin, call: { id: `tool-${i}`, name: i % 2 ? "Edit" : "Read", parent_id: null, input: { file_path: `/project/src/file-${i}.tsx`, old_string: "old", new_string: "new" } }, stream: "", output: "A received line of output.\n".repeat(80), complete: true, isError: false })
const text = (i: number) => `## Section ${i}\n\n` + "Preserve **formatted content** and `inline code` while scrolling through the conversation. ".repeat(12) + `\n\n\`\`\`typescript\n${Array.from({ length: 24 }, (_, n) => `export const value${n} = ${i + n};`).join("\n")}\n\`\`\`\n\n| Name | Value |\n| --- | --- |\n| item | ${i} |`
const histories = Array.from({ length: 160 }, (_, i) => [user(`turn-${i}`), answer(`turn-${i}:answer`, text(i)), end(`turn-${i}`)]).flat()
const work = [user("work"), ...Array.from({ length: 800 }, (_, i) => [answer(`work:reason-${i}`, "", true, `Reasoning about file ${i}. `.repeat(20)), tool(i)]).flat(), answer("work:tail", "New output.", false)]
const groupedWork = [user("work"), ...Array.from({ length: 800 }, (_, i) => { const block = tool(i) as Extract<Block, { kind: "tool" }>; return { ...block, call: { ...block.call, name: "Read" } } }), answer("work:tail", "New output.", false)]
const longCode = "```typescript\n" + Array.from({ length: 5000 }, (_, i) => `export function fn${i}(value: number) { return value + ${i}; }`).join("\n") + "\n```"
const viewport = () => document.querySelector<HTMLElement>("[data-chat-scroll-container]")!
const native = () => (window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }).webkit.messageHandlers.bench
const failures: string[] = []
declare const __SCROLL_SCENARIO__: string
declare const __SCROLL_FRAMES__: number
declare const __SCROLL_MEMORY__: boolean
window.addEventListener("error", e => failures.push(e.message))
function publish(blocks: Block[]) { useStore.getState().set({ transcripts: { fixture: { ...emptyThreadState(), loaded: true, blocks } } }) }
async function run() {
  document.documentElement.classList.add("dark")
  publish(histories)
  flushSync(() => createRoot(document.getElementById("root")!).render(<ThemeProviderContext value={{ theme: "dark", translucent: false, setTheme: () => {}, setTranslucent: () => {} }}><div className="flex h-screen flex-col"><Transcript threadId="fixture" bottomInset={0} /></div></ThemeProviderContext>))
  const samples = []
  for (const scenario of ["history-cold", "history-warm", "history-fast", "mixed-work", "mixed-work-streaming", "expanded-thinking", "expanded-tools", "long-code"] as const) {
    if (__SCROLL_SCENARIO__ && scenario !== __SCROLL_SCENARIO__) continue
    const blocks = scenario.startsWith("history") ? histories : scenario === "long-code" ? [user("code"), answer("code:answer", longCode), end("code")] : scenario === "expanded-tools" ? groupedWork : work
    flushSync(() => publish(blocks))
    const view = viewport()
    view.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }))
    view.scrollTop = 0
    await sleep(scenario === "long-code" ? 1800 : 400)
    if (scenario === "history-cold") {
      // Start this backward cold-history comparison consistently, independent
      // of the mount-follow callback racing the fixture's initial gesture.
      view.scrollTop = view.scrollHeight
      await sleep(150)
      view.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }))
    }
    if (scenario.startsWith("expanded-")) {
      view.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }))
      view.scrollTop = 0
      await sleep(150)
      const buttons = Array.from(view.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]')).filter(button => scenario === "expanded-tools" ? /Read 800/.test(button.textContent ?? "") : /^(Thinking|Thought)/.test(button.textContent ?? ""))
      if (!buttons.length) failures.push(`Missing ${scenario} disclosures`)
      buttons.slice(0, 8).forEach(button => button.click())
      await sleep(300)
    }
    if (scenario === "long-code") {
      const code = view.querySelector("[data-message-role] pre code")
      if (code?.textContent?.trimEnd() !== longCode.slice("```typescript\n".length, -"\n```".length)) failures.push("Long code lost its fenced structure or exact content")
    }
    let received = "New output."
    const stream = scenario === "mixed-work-streaming" ? setInterval(() => {
      received += "The agent is still working. "
      publish([...blocks.slice(0, -1), answer("work:tail", received, false)])
    }, 32) : undefined
    native().postMessage(JSON.stringify({ stage: `scrolling ${scenario}`, process: true }))
    const intervals: number[] = [], movingIntervals: number[] = [], corrections: number[] = [], jumps: number[] = []
    const jumpDetails: unknown[] = []
    const initialTop = view.scrollTop
    let previous = await frame(), peakNodes = 0, emptyFrames = 0
    const visibleAnchor = () => Array.from(view.querySelectorAll<HTMLElement>('[data-message-role] p, [data-message-role] pre code, [data-work-entry-display-text]')).find(el => { const rect = el.getBoundingClientRect(); return rect.bottom > 60 && rect.top < innerHeight - 80 })
    for (const direction of [1, -1]) {
      for (let i = 0; i < __SCROLL_FRAMES__; i++) {
        const anchor = visibleAnchor()
        const anchorTop = anchor?.getBoundingClientRect().top
        const before = view.scrollTop
        view.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: direction * 80 }))
        view.scrollTop += direction * (12 + (scenario === "history-fast" ? 800 : 140) * Math.sin(Math.PI * (i % 100) / 100))
        const requested = view.scrollTop
        const now = await frame()
        intervals.push(now - previous)
        if (requested !== before) movingIntervals.push(now - previous)
        previous = now
        await sleep(0)
        if (!visibleAnchor()) emptyFrames++
        corrections.push(Math.abs(view.scrollTop - requested))
        if (anchor?.isConnected && anchorTop != null) {
          const currentTop = anchor.getBoundingClientRect().top
          const jump = Math.abs(currentTop - anchorTop + requested - before)
          jumps.push(jump)
          if (jump > 8) jumpDetails.push({ direction, i, before, requested, actual: view.scrollTop, anchorTop, currentTop, turn: anchor.closest<HTMLElement>('[data-turn-id]')?.dataset.turnId })
        }
        if (i % 20 === 0) peakNodes = Math.max(peakNodes, document.querySelectorAll("*").length)
      }
    }
    clearInterval(stream)
    if (jumps.length < 20 || movingIntervals.length < 20) failures.push(`${scenario} did not exercise enough visible anchors or scrolling`)
    if (emptyFrames) failures.push(`${scenario} painted ${emptyFrames} empty viewports`)
    const result = { scenario, initialTop, jumpDetails, frames: intervals.length, movingFrames: movingIntervals.length, anchorFrames: jumps.length, emptyFrames, frameP95: p95(intervals), movingFrameP95: p95(movingIntervals), worstFrame: Math.max(...intervals), over25ms: intervals.filter(x => x > 25).length, correctionP95: p95(corrections), maxCorrection: Math.max(...corrections), maxVisibleJump: Math.max(0, ...jumps), peakNodes }
    samples.push(result)
    native().postMessage(JSON.stringify({ stage: scenario, ...result }))
    if (__SCROLL_MEMORY__) await new Promise<void>(resolve => {
      Object.assign(window, { __memoryContinue: resolve })
      native().postMessage(JSON.stringify({ stage: `${scenario} memory`, memory: true }))
    })
  }
  native().postMessage(JSON.stringify({ samples, failures, pass: failures.length === 0 && samples.every(s => s.frameP95 < 25 && s.movingFrameP95 < 25 && s.worstFrame < 100 && s.maxVisibleJump < 8) }))
}
run().catch(error => native().postMessage(JSON.stringify({ pass: false, error: String(error), failures })))
