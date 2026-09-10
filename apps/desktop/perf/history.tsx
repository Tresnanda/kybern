import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { Transcript } from "../src/views/Transcript"
import { ThemeProviderContext } from "../src/components/theme-context"
import { useStore } from "../src/state/store"
import { emptyThreadState, type Block } from "../src/state/transcript"
import { calls, fixture } from "./history-rpc"
import "../src/index.css"
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
async function waitFor(condition: () => unknown, message: string) {
  const until = performance.now() + 5000
  while (!condition() && performance.now() < until) await sleep(20)
  check(condition(), message)
}
const at = "2026-09-10T00:00:00Z"
let seq = 0
fixture.all = Array.from({ length: 200 }, (_, i): Block[] => {
  const turnId = `turn-${i}`
  return [
    { kind: "user", id: `u-${i}`, turnId, at, seq: ++seq, message: { parts: [{ type: "text", text: `Question ${i}` }] } },
    { kind: "assistant", id: `a-${i}`, messageId: `a-${i}`, turnId, at, seq: ++seq, segment: 0, text: `## Reply ${i}\n\n` + "Keep this paragraph in place while earlier messages arrive. ".repeat(10), thinking: "", complete: true, origin: { kind: "root" } },
    { kind: "turn_end", id: `e-${i}`, turnId, at, seq: ++seq, stopReason: "completed", usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, costUsd: null, durationMs: 1000, terminalMessageId: `a-${i}`, error: null },
  ]
}).flat()
const scroll = () => document.querySelector<HTMLElement>('[data-chat-scroll-container]')!
async function approach() {
  scroll().dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }))
  scroll().scrollTop = scroll().clientHeight * 1.5
  scroll().dispatchEvent(new Event("scroll"))
  await sleep(80)
  const top = scroll().getBoundingClientRect().top
  const node = [...document.querySelectorAll<HTMLElement>('[data-turn-id]')].find(row => row.getBoundingClientRect().top >= top && row.getBoundingClientRect().top < top + scroll().clientHeight)
  check(node, "A visible reading anchor is mounted")
  return { id: node.dataset.turnId!, top: node.getBoundingClientRect().top }
}
function anchorTop(id: string) { return document.querySelector<HTMLElement>(`[data-turn-id="${id}"]`)!.getBoundingClientRect().top }
async function run() {
  window.addEventListener("error", event => native.webkit.messageHandlers.bench.postMessage(JSON.stringify({ stage: "runtime-error", message: event.message })))
  document.documentElement.classList.add("dark")
  useStore.getState().set({ selected: { kind: "thread", id: "history" }, connection: { state: "open" }, transcripts: { history: { ...emptyThreadState(), loaded: true, blocks: fixture.all.slice(-60), nextBeforeSeq: fixture.all.at(-60)!.seq } } })
  flushSync(() => createRoot(document.getElementById("root")!).render(<ThemeProviderContext value={{ theme: "dark", translucent: false, setTheme: () => {}, setTranslucent: () => {} }}><div className="flex h-screen flex-col"><Transcript threadId="history" bottomInset={0} /></div></ThemeProviderContext>))
  await waitFor(() => scroll(), `History viewport mounts: ${document.body.innerText}`)
  await sleep(500)
  check(calls.length === 0, "Opening at the latest reply must not download older history")
  let maxAnchorShift = 0
  const first = await approach()
  await waitFor(() => calls.length === 1 && !useStore.getState().transcripts.history!.loadingEarlier, "Approaching history loads a page automatically")
  await sleep(150)
  maxAnchorShift = Math.max(maxAnchorShift, Math.abs(anchorTop(first.id) - first.top))
  check(maxAnchorShift < 2, `Prepending moved the reading anchor by ${maxAnchorShift}px`)
  check(calls[0]!.distance > scroll().clientHeight, "Prefetch starts before the oldest loaded message is visible")
  fixture.failNext = true
  await approach()
  await waitFor(() => calls.length === 2 && !useStore.getState().transcripts.history!.loadingEarlier, "Failed history request completes")
  scroll().scrollTop = 0
  await waitFor(() => document.body.innerText.includes("Connection interrupted"), "History failure provides inline recovery")
  const count = calls.length
  await waitFor(() => scroll(), `History viewport mounts: ${document.body.innerText}`)
  await sleep(500)
  check(calls.length === count, "Failure does not trigger an automatic retry loop")
  scroll().scrollTop = 0
  await sleep(100)
  const retry = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Retry")
  check(retry, "History retry is reachable")
  retry.click()
  await waitFor(() => calls.length === count + 1 && !useStore.getState().transcripts.history!.loadingEarlier, "Retry resumes paging")
  while (useStore.getState().transcripts.history!.nextBeforeSeq !== null) {
    const anchor = await approach()
    await waitFor(() => !useStore.getState().transcripts.history!.loadingEarlier, "Next page arrives")
    await sleep(150)
    maxAnchorShift = Math.max(maxAnchorShift, Math.abs(anchorTop(anchor.id) - anchor.top))
    check(maxAnchorShift < 2, `Repeated paging moved the anchor by ${maxAnchorShift}px`)
  }
  const final = calls.length
  await approach()
  await sleep(300)
  check(calls.length === final, "Exhausted history stops paging")
  check(useStore.getState().transcripts.history!.blocks.length === 600, "All messages remain reachable")
  check(document.querySelectorAll('[data-turn-id]').length < 20, "History remains virtualized")
  check(!!document.querySelector('.chat-markdown h2'), "Formatted output survives paging")
  return { pass: true, pages: calls.length, maxAnchorShift, boundedMountedRows: document.querySelectorAll('[data-turn-id]').length, calls }
}
const native = window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }
run().then(result => native.webkit.messageHandlers.bench.postMessage(JSON.stringify(result))).catch(error => native.webkit.messageHandlers.bench.postMessage(JSON.stringify({ pass: false, error: String(error) })))
