import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { Transcript } from "../src/views/Transcript"
import { ThemeProviderContext } from "../src/components/theme-context"
import { useStore } from "../src/state/store"
import { emptyThreadState, type Block } from "../src/state/transcript"
import { retainedSize } from "../src/lib/retainedSize"
import { fixture, calls } from "./history-rpc"
import "../src/index.css"
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
async function waitFor(condition: () => unknown, message: string) {
  const end = performance.now() + 15000
  while (!condition() && performance.now() < end) await sleep(20)
  check(condition(), message)
}
const at = "2026-09-14T00:00:00Z"
fixture.all = Array.from({ length: 1000 }, (_, i): Block[] => [
  { kind: "user", id: `u${i}`, turnId: `t${i}`, seq: i * 3 + 1, at, message: { parts: [{ type: "text", text: `Question ${i}` }] } },
  { kind: "assistant", id: `a${i}`, messageId: `a${i}`, segment: 0, turnId: `t${i}`, seq: i * 3 + 2, at, origin: { kind: "root" }, text: `## Answer ${i}\n\nKeep **formatted content** and the reading position.`, thinking: "", complete: true },
  { kind: "turn_end", id: `e${i}`, turnId: `t${i}`, seq: i * 3 + 3, at, stopReason: "completed", usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, costUsd: null, durationMs: 100, terminalMessageId: `a${i}`, error: null },
]).flat()
const state = () => useStore.getState().transcripts.history!
const scroll = () => document.querySelector<HTMLElement>("[data-chat-scroll-container]")!
async function run() {
  document.documentElement.classList.add("dark")
  useStore.getState().set({ selected: { kind: "thread", id: "history" }, connection: { state: "open" }, transcripts: { history: { ...emptyThreadState(), loaded: true, blocks: fixture.all, lastSeq: 3000 } } })
  const beforeBytes = retainedSize(state().blocks)
  flushSync(() => createRoot(document.getElementById("root")!).render(<ThemeProviderContext value={{ theme: "dark", translucent: false, setTheme: () => {}, setTranslucent: () => {} }}><div className="flex h-screen flex-col"><Transcript threadId="history" bottomInset={0} /></div></ThemeProviderContext>))
  // WebKit can keep emitting scroll notifications at the live edge. They must
  // not indefinitely postpone cleanup when there is no reading interaction.
  const notifications = setInterval(() => scroll()?.dispatchEvent(new Event("scroll")), 30)
  try {
    await waitFor(() => state().blocks.length === 600, "Following a long chat releases older completed turns")
  } finally { clearInterval(notifications) }
  const afterBytes = retainedSize(state().blocks)
  check(state().nextBeforeSeq === 2401, "Evicted history has an exact reload cursor")
  check(state().blocks.at(-2) === fixture.all.at(-2), "Latest answer retains its object identity")
  check(document.body.innerText.includes("Answer 999"), "Latest formatted answer stays visible")
  // The store changes before React commits and WebKit finishes end anchoring.
  await waitFor(() => scroll().scrollHeight - scroll().clientHeight - scroll().scrollTop < 60, "Cleanup preserves following position")
  scroll().dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }))
  scroll().scrollTop = 1000
  await sleep(60)
  const top = scroll().getBoundingClientRect().top
  const anchor = [...document.querySelectorAll<HTMLElement>("[data-turn-id]")].find(node => node.getBoundingClientRect().top >= top && node.getBoundingClientRect().top < top + scroll().clientHeight)!
  check(anchor, "Reading anchor exists")
  const anchorTop = anchor.getBoundingClientRect().top
  await waitFor(() => calls.length === 1 && !state().loadingEarlier, "Released history reloads on upward reading")
  await sleep(350)
  check(state().blocks.length === 720, "Reloaded history stays retained while reading")
  const anchorShift = Math.abs(anchor.getBoundingClientRect().top - anchorTop)
  check(anchor.isConnected && anchorShift < 2, `Reload preserves reading position: ${anchorShift}px`)
  document.querySelector<HTMLButtonElement>('[aria-label="Scroll to bottom"]')!.click()
  await sleep(250)
  const answer = [...document.querySelectorAll<HTMLElement>(".chat-markdown")].at(-1)!
  const range = document.createRange()
  range.selectNodeContents(answer)
  document.getSelection()!.removeAllRanges()
  document.getSelection()!.addRange(range)
  flushSync(() => useStore.getState().updateTranscript("history", current => ({ ...current, blocks: fixture.all, nextBeforeSeq: null })))
  await sleep(500)
  check(state().blocks.length === 3000, "Selection pins loaded history")
  check(answer.isConnected && document.getSelection()!.toString().includes("Answer 999"), "Selection and highlighted DOM survive")
  document.getSelection()!.removeAllRanges()
  await waitFor(() => state().blocks.length === 600, "Releasing selection permits cleanup")
  const focus = [...document.querySelectorAll<HTMLElement>("[data-turn-id]")].at(-1)!.querySelector<HTMLButtonElement>("button")!
  check(focus, "A real message action can retain focus")
  focus.focus({ preventScroll: true })
  check(document.activeElement === focus, `Message action receives focus: ${focus.outerHTML}`)
  flushSync(() => useStore.getState().updateTranscript("history", current => ({ ...current, blocks: fixture.all, nextBeforeSeq: null })))
  await sleep(500)
  check(state().blocks.length === 3000 && document.activeElement === focus, `Focused message controls pin history; connected=${focus.isConnected}, active=${document.activeElement?.outerHTML.slice(0, 600)}`)
  focus.blur()
  await waitFor(() => state().blocks.length === 600, "Leaving the focused control permits cleanup")
  return { pass: true, beforeBlocks: 3000, afterBlocks: state().blocks.length, beforeBytes, afterBytes, anchorShift, reload: true, selection: true, focus: true, identity: true }
}
const w = window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (value: string) => void } } } }
run().then(result => w.webkit.messageHandlers.bench.postMessage(JSON.stringify(result))).catch(error => w.webkit.messageHandlers.bench.postMessage(JSON.stringify({ pass: false, error: String(error), blocks: state()?.blocks.length, hidden: document.hidden, selection: { collapsed: document.getSelection()?.isCollapsed, ranges: document.getSelection()?.rangeCount }, active: document.activeElement?.outerHTML.slice(0, 200), scroll: { top: scroll()?.scrollTop, height: scroll()?.scrollHeight, client: scroll()?.clientHeight }, bottomButton: document.querySelector('[aria-label="Scroll to bottom"]')?.className })))
