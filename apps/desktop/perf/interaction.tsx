// Exercise navigation and user state through the real virtualized transcript.
import { useLayoutEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { Transcript } from "../src/views/Transcript"
import { useStore } from "../src/state/store"
import { emptyThreadState, type Block } from "../src/state/transcript"
import { ThemeProviderContext } from "../src/components/theme-context"
import "../src/index.css"
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function waitFor(check: () => boolean, label: string, limit = 2500) {
  const until = performance.now() + limit
  while (!check() && performance.now() < until) await sleep(20)
  if (!check()) throw new Error(label)
}
function check(value: unknown, label: string): asserts value { if (!value) throw new Error(label) }
const results: Record<string, boolean | number> = {}
const at = "2026-09-01T12:00:00Z"
const origin = { kind: "root" } as const
let seq = 0
const answer = "A paragraph with selectable content.\n\n```text\nconst example = 'a line long enough to wrap when the user asks for it';\n```\n\n" + "The answer preserves the reader’s place. ".repeat(8)
function user(turnId: string): Block { return { kind: "user", id: `user-${turnId}`, turnId, at, seq: ++seq, message: { parts: [{ type: "text", text: `Question ${turnId}` }] } } }
function assistant(turnId: string, text = answer): Block { return { kind: "assistant", id: `answer-${turnId}`, messageId: `answer-${turnId}`, turnId, at, seq: ++seq, segment: 0, text, thinking: "", complete: true, origin } }
function end(turnId: string): Block { return { kind: "turn_end", id: `end-${turnId}`, turnId, at, seq: ++seq, stopReason: "completed", usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, costUsd: null, durationMs: 1000, terminalMessageId: `answer-${turnId}`, error: null } }
const history: Block[] = Array.from({ length: 200 }, (_, i) => [user(`turn-${i}`), assistant(`turn-${i}`), end(`turn-${i}`)]).flat()
const heavy: Block[] = [user("heavy"), ...Array.from({ length: 800 }, (_, i): Block => ({ kind: "tool", id: `tool-${i}`, turnId: "heavy", at, seq: ++seq, origin, call: { id: `tool-${i}`, name: "Read", input: { file_path: `/project/src/file-${i}.ts` }, parent_id: null }, stream: "", output: `Output from file ${i}.`, isError: false, complete: true })), assistant("heavy", "Finished reading."), end("heavy")]
let blocks = [...history, ...heavy]
const controls: { thread: (id: string) => void } = { thread: () => {} }
export function Demo() {
  const [thread, setThread] = useState("fixture")
  useLayoutEffect(() => { controls.thread = setThread }, [])
  return <ThemeProviderContext value={{ theme: "dark", translucent: false, setTheme: () => {}, setTranslucent: () => {} }}><div id="layout" className="flex h-screen flex-col"><Transcript threadId={thread} bottomInset={0} /></div></ThemeProviderContext>
}
const viewport = () => document.querySelector<HTMLElement>('[data-chat-scroll-container]')!
const rail = () => document.querySelector<HTMLElement>('nav[aria-label="Message navigation"]')!
const turn = (id: string) => document.querySelector<HTMLElement>(`[data-turn-id="${id}"]`)
function visible(element: HTMLElement | null) {
  if (!element) return false
  const rect = element.getBoundingClientRect(), view = viewport().getBoundingClientRect()
  return rect.bottom > view.top && rect.top < view.bottom
}
async function railItem(index: number) {
  const nav = rail()
  check(nav, "Rail is available")
  nav.scrollTop = index * 12
  // Keyboard navigation also mounts targets well beyond the current tick range.
  nav.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }))
  await waitFor(() => !!nav.querySelector('[data-rail-index="0"]') && (document.activeElement as HTMLElement | null)?.dataset.railIndex === "0", "First rail item focused")
  await sleep(30)
  if (index === 401) nav.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }))
  else if (index > 0) {
    const first = nav.querySelector<HTMLElement>('[data-rail-index="0"]')!
    // Move the independent rail to the requested region, then use its real button.
    const height = first.getBoundingClientRect().height
    nav.scrollTop = index * height
  }
  await waitFor(() => !!nav.querySelector(`[data-rail-index="${index}"]`), `Rail item ${index} mounted`)
  const button = nav.querySelector<HTMLButtonElement>(`[data-rail-index="${index}"]`)!
  const tickRect = button.getBoundingClientRect(), navRect = nav.getBoundingClientRect()
  check(tickRect.bottom > navRect.top && tickRect.top < navRect.bottom, `Rail item ${index} is visible`)
  button.click()
  await sleep(220)
  return button
}
function publish(next: Block[]) {
  blocks = next
  useStore.getState().set({ transcripts: { ...useStore.getState().transcripts, fixture: { ...emptyThreadState(), loaded: true, blocks } } })
}
async function run() {
  document.documentElement.classList.add("dark")
  publish(blocks)
  flushSync(() => createRoot(document.getElementById("root")!).render(<Demo />))
  await waitFor(() => rail()?.dataset.virtualRail === "true" && !!rail()?.querySelector("button"), "Initial rail")
  await railItem(0)
  check(visible(turn("turn-0")?.querySelector('[data-message-role="user"]') ?? null), "First message is visible")
  results.firstNavigation = true
  await railItem(200)
  check(visible(turn("turn-100")?.querySelector('[data-message-role="user"]') ?? null), "Middle message is visible")
  results.middleNavigation = true
  const middle = turn("turn-100")!
  const wrap = middle.querySelector<HTMLButtonElement>('[aria-label="Wrap lines"]')!
  check(wrap, "Middle code block is rendered")
  wrap.click()
  await sleep(30)
  check(middle.querySelector('[data-wrap="true"]'), "Wrap toggled")
  await railItem(401)
  check(visible(turn("heavy")), "Last message is visible")
  check(!middle.isConnected, "Offscreen middle row is unmounted")
  results.lastNavigation = true
  await railItem(200)
  check(turn("turn-100")?.querySelector('[data-wrap="true"]'), "Code wrap survives virtual unmount")
  results.wrapState = true

  const paragraph = turn("turn-100")!.querySelector<HTMLElement>('.chat-markdown p')!
  const range = document.createRange()
  range.selectNodeContents(paragraph)
  const selection = document.getSelection()!
  selection.removeAllRanges(); selection.addRange(range)
  const selected = selection.toString()
  await sleep(30)
  // Scrolling elsewhere does not destroy an active text selection.
  viewport().dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }))
  viewport().scrollTop = 0
  await sleep(200)
  check(paragraph.isConnected && selection.toString() === selected && selected.length > 0, "Text selection survives scrolling")
  results.selection = true
  selection.removeAllRanges()
  await sleep(100)
  check(!paragraph.isConnected, "Clearing selection releases offscreen rows")
  results.selectionRelease = true

  await railItem(200)
  const focused = turn("turn-100")!.querySelector<HTMLButtonElement>('[aria-label="Disable line wrap"]')!
  focused.focus({ preventScroll: true })
  await sleep(30)
  viewport().scrollTop = 0
  await sleep(150)
  check(focused.isConnected && document.activeElement === focused, "Keyboard focus survives scrolling")
  results.focus = true
  focused.blur()
  await sleep(100)
  check(!focused.isConnected, "Blur releases offscreen row")

  await railItem(200)
  const anchor = turn("turn-100")!
  const readingTop = anchor.getBoundingClientRect().top
  publish(blocks.map(block => block.id === "answer-heavy" && block.kind === "assistant" ? { ...block, text: block.text + " More final output.".repeat(10) } : block))
  await sleep(180)
  check(Math.abs(anchor.getBoundingClientRect().top - readingTop) < 2, "New output preserves history reading position")
  results.readingPosition = true
  const older = [user("older"), assistant("older"), end("older")]
  publish([...older, ...blocks])
  await sleep(200)
  check(Math.abs(turn("turn-100")!.getBoundingClientRect().top - readingTop) < 2, "Prepending history preserves the visible anchor")
  results.prepend = true
  // Keep the original fixture indices for the remaining navigation checks.
  publish(blocks.slice(3))
  await sleep(150)

  await railItem(400)
  flushSync(() => useStore.getState().toggleWork("heavy"))
  await sleep(100)
  const group = Array.from(turn("heavy")!.querySelectorAll<HTMLButtonElement>("button")).find(button => /Read 800/.test(button.textContent ?? ""))!
  check(group, "Grouped tool disclosure exists")
  group.click()
  await sleep(150)
  await railItem(400)
  const findTool = (index: number) => Array.from(document.querySelectorAll<HTMLElement>("[data-work-entry-display-text]")).find(el => el.textContent?.endsWith(`file-${index}.ts`))?.closest<HTMLButtonElement>("button")
  await waitFor(() => !!findTool(0), "First tool is mounted")
  const firstTool = findTool(0)!
  firstTool.click()
  await sleep(50)
  check(firstTool.getAttribute("aria-expanded") === "true", "First tool expanded")
  await railItem(401)
  await waitFor(() => !!findTool(799), "Last tool can be reached")
  check(!firstTool.isConnected, "Offscreen tool is unmounted")
  const mountedTools = document.querySelectorAll("[data-work-entry-display-text]").length
  check(mountedTools < 100, "Expanded work remains bounded")
  results.mountedTools = mountedTools
  await railItem(400)
  await waitFor(() => !!findTool(0), "First tool remounted")
  check(findTool(0)!.getAttribute("aria-expanded") === "true", "Tool expansion survives virtual unmount")
  results.toolState = true
  await railItem(0)
  await railItem(400)
  check(Array.from(turn("heavy")!.querySelectorAll<HTMLButtonElement>("button")).find(button => /Read 800/.test(button.textContent ?? ""))?.getAttribute("aria-expanded") === "true", "Group expansion survives turn unmount")
  results.groupState = true

  await railItem(200)
  document.getElementById("layout")!.style.width = "780px"
  await sleep(220)
  check(visible(turn("turn-100")), "Resize retains visible turn")
  document.getElementById("layout")!.style.width = ""
  results.resize = true
  useStore.getState().set({ transcripts: { ...useStore.getState().transcripts, second: { ...emptyThreadState(), loaded: true, blocks: [user("second"), assistant("second"), end("second")] } } })
  flushSync(() => controls.thread("second"))
  await waitFor(() => !!turn("second"), "Thread switch renders new transcript")
  check(!turn("turn-100"), "Thread switch removes old rows")
  check(!turn("second")!.querySelector('[data-wrap="true"]'), "Thread state stays isolated")
  results.threadSwitch = true
  flushSync(() => controls.thread("fixture"))
  await sleep(200)
  await railItem(401)
  publish(blocks.map(block => block.id === "answer-heavy" && block.kind === "assistant" ? { ...block, text: block.text + "\n\n" + "New output. ".repeat(70) } : block))
  await sleep(350)
  check(viewport().scrollHeight - viewport().scrollTop - viewport().clientHeight < 60, "Following tracks new output after thread switch")
  results.follow = true
  const launch: Block = { kind: "tool", id: "agent-parent", turnId: "agent-turn", at, seq: ++seq, origin, call: { id: "agent-parent", name: "Task", input: { description: "Review files", prompt: "Inspect the project files" }, parent_id: null }, stream: "", output: "The agent finished reviewing.", isError: false, complete: true }
  const childTools = heavy.filter((block): block is Extract<Block, { kind: "tool" }> => block.kind === "tool").map(block => ({ ...block, id: "child-" + block.id, turnId: "agent-turn", call: { ...block.call, id: "child-" + block.call.id, parent_id: "agent-parent" } }))
  useStore.getState().set({ transcripts: { ...useStore.getState().transcripts, agents: { ...emptyThreadState(), loaded: true, blocks: [user("agent-turn"), launch, ...childTools, assistant("agent-turn"), end("agent-turn")] } } })
  flushSync(() => controls.thread("agents"))
  await waitFor(() => !!document.querySelector('[data-agent-launch-row="true"]'), "Agent launch is visible")
  document.querySelector<HTMLButtonElement>('[data-agent-launch-row="true"]')!.click()
  await waitFor(() => !!document.querySelector('[data-agent-activity-detail="true"]'), "Agent detail opens")
  const detail = document.querySelector<HTMLElement>('[data-agent-activity-detail="true"]')!
  await sleep(100)
  check(detail.querySelectorAll("[data-work-entry-display-text]").length < 100, "Agent activity is virtualized")
  detail.scrollTop = detail.scrollHeight
  await waitFor(() => [...detail.querySelectorAll("[data-work-entry-display-text]")].some(el => el.textContent?.endsWith("file-799.ts")), "Last agent activity is reachable")
  results.agentActivity = true
  report({ ...results, pass: true })
}
function report(value: unknown) {
  const native = window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }
  native.webkit.messageHandlers.bench.postMessage(JSON.stringify(value))
}
run().catch(error => report({ ...results, pass: false, error: String(error), rail: { actualFocus: (document.activeElement as HTMLElement | null)?.dataset.railIndex, connected: rail()?.isConnected, top: rail()?.scrollTop, height: rail()?.clientHeight, total: rail()?.scrollHeight, buttons: [...(rail()?.querySelectorAll<HTMLElement>("[data-rail-index]") ?? [])].map(el => [el.dataset.railIndex, el.getBoundingClientRect().height]) }, top: viewport()?.scrollTop, height: viewport()?.scrollHeight, rows: [...document.querySelectorAll<HTMLElement>("[data-turn-id]")].map(el => el.dataset.turnId) }))
