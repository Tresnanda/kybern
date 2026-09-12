// Active work, disclosure re-entry and changing virtual row keys in native WebKit.
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { Transcript } from "../src/views/Transcript"
import { useStore } from "../src/state/store"
import { applyEvent, emptyThreadState, type Block } from "../src/state/transcript"
import type { ThreadEvent } from "../src/protocol"
import { ThemeProviderContext } from "../src/components/theme-context"
import "../src/index.css"

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const frame = () => new Promise<number>(resolve => requestAnimationFrame(resolve))
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * .95)] ?? 0
const origin = { kind: "root" } as const
const at = "2026-09-01T12:00:00Z"
declare const __WORK_REPLAY__: ThreadEvent[]
let seq = 0
const base = (id: string) => ({ id, turnId: "work", at, seq: ++seq })
function thought(id: string, text: string, complete = false): Block {
  return { ...base(id), kind: "assistant", messageId: id, segment: 0, thinking: text, text: "", complete, origin }
}
function tool(i: number, name = i % 2 ? "Edit" : "Read", complete = true): Block {
  return { ...base(`tool-${i}`), kind: "tool", origin, call: { id: `tool-${i}`, name, parent_id: null, input: { file_path: `/project/src/file-${i}.tsx`, old_string: "before", new_string: "after" } }, stream: "", output: "Large output that should only mount when opened.\n".repeat(2000), complete, isError: false }
}
const prompt: Block = { ...base("user"), kind: "user", message: { parts: [{ type: "text", text: "Inspect and edit the project" }] } }
let blocks: Block[] = []
function publish(next: Block[]) {
  blocks = next
  flushSync(() => useStore.getState().set({ transcripts: { fixture: { ...emptyThreadState(), loaded: true, blocks } } }))
}
const failures: string[] = []
window.addEventListener("error", event => { failures.push(`window error: ${event.message}`) })
const checks: Record<string, boolean | number> = {}
function check(ok: unknown, label: string) { checks[label] = !!ok; if (!ok) failures.push(label) }
const viewport = () => document.querySelector<HTMLElement>("[data-chat-scroll-container]")!
const thinkingButton = () => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(el => /^(Thinking|Thought)/.test(el.textContent ?? ""))!
const thinkingText = () => thinkingButton()?.parentElement?.querySelector<HTMLElement>("p.selectable")?.textContent ?? ""
function overlaps() {
  const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-work-entry-display-text], [data-work-group-display-text]")).filter(el => !el.closest('[aria-hidden="true"], [inert], [hidden]')).map(el => {
    const rect = el.getBoundingClientRect()
    let top = rect.top, bottom = rect.bottom
    for (let node = el.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (Number(style.opacity) < .1) bottom = top
      if (style.overflowY !== "visible") { const clip = node.getBoundingClientRect(); top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom) }
    }
    return { text: el.textContent, rect: { top, bottom, height: bottom - top } }
  }).filter(({ rect }) => rect.height > 2 && rect.bottom > 0 && rect.top < innerHeight)
  return rows.flatMap((a, i) => rows.slice(i + 1).filter(b => Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top) > 2).map(b => `${a.text} / ${b.text}`))
}
async function run() {
  document.documentElement.classList.add("dark")
  useStore.getState().set({ selected: { kind: "thread", id: "fixture" }, splitView: null })
  const initial = "Start documentation. " + "Review additional context and preserve the whole thinking trace. ".repeat(20)
  publish([prompt, thought("reason", initial)])
  flushSync(() => createRoot(document.getElementById("root")!, { onUncaughtError: error => { failures.push(`React: ${String(error)}`) } }).render(
    <ThemeProviderContext value={{ theme: "dark", translucent: false, setTheme: () => {}, setTranslucent: () => {} }}>
      <div className="flex h-screen flex-col"><input id="typing-probe" aria-label="Typing probe" /><Transcript threadId="fixture" bottomInset={0} /></div>
    </ThemeProviderContext>,
  ))
  await sleep(150)
  thinkingButton().click()
  await sleep(300)
  check(thinkingText() === initial, "opening received thinking shows all text")
  thinkingButton().click()
  await sleep(300)
  check(!thinkingButton().parentElement?.querySelector("p.selectable"), "closed thinking unmounts its content")
  const extended = initial + "Received while collapsed. ".repeat(20)
  publish([prompt, thought("reason", extended)])
  await sleep(40)
  thinkingButton().click()
  await sleep(300)
  check(thinkingText() === extended, "reopening after hidden deltas shows all text")
  for (let i = 0; i < 4; i++) { thinkingButton().click(); await sleep(30) }
  await sleep(300)
  check(thinkingText() === extended, "rapid toggles retain thinking")
  // Interrupt a pending follow before its virtual scroll target settles.
  await frame()
  document.querySelector<HTMLButtonElement>('[aria-label="Scroll to bottom"]')!.click()
  viewport().dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }))
  viewport().scrollTop = 0
  // WebKit may deliver a queued layout scroll event without any movement.
  // That must not resume following after an upward gesture on short content.
  viewport().dispatchEvent(new Event("scroll"))
  publish([prompt, thought("reason", extended), ...Array.from({ length: 32 }, (_, i) => thought(`remount-${i}`, "Previous reasoning.", true))])
  viewport().scrollTop = 0
  await sleep(100)
  check(viewport().scrollTop < 1, "layout scroll echoes do not resume following after an upward gesture")
  check(thinkingText() === extended, "virtual remount retains the entire expanded live trace")
  publish([prompt, thought("reason", extended, true)])
  await sleep(250)
  check(thinkingText() === extended, "completion shows exact thinking")

  // Expanding history must also keep whole neighbouring turns separated.
  publish(Array.from({ length: 3 }, (_, i) => [
    { ...prompt, id: `adjacent-user-${i}`, turnId: `adjacent-${i}` },
    { ...thought(`adjacent-thought-${i}`, extended, true), turnId: `adjacent-${i}` },
  ]).flat())
  await sleep(300)
  viewport().dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }))
  viewport().scrollTop = 0
  await sleep(100)
  let turnCollisions = 0
  for (let toggle = 0; toggle < 2; toggle++) {
    thinkingButton().click()
    for (let i = 0; i < 20; i++) {
      await frame(); await sleep(0)
      const turns = Array.from(document.querySelectorAll<HTMLElement>("[data-turn-id]")).map(el => el.getBoundingClientRect())
      turnCollisions += turns.slice(1).filter((rect, index) => rect.top < turns[index]!.bottom - 2 && rect.top < innerHeight && turns[index]!.bottom > 0).length
    }
  }
  checks.turnCollisions = turnCollisions
  check(turnCollisions === 0, "expanding and collapsing work keeps adjacent turns separated")

  publish([prompt, ...Array.from({ length: 29 }, (_, i) => tool(i, undefined, false))])
  await sleep(200)
  let collisions = 0
  for (let i = 29; i < 65; i++) {
    publish([...blocks, tool(i, undefined, false)])
    await frame()
    collisions += overlaps().length
    await frame()
    collisions += overlaps().length
  }
  await sleep(300)
  check(overlaps().length === 0, "mixed read and edit rows never settle overlapping")
  checks.overlapFrames = collisions
  check(collisions === 0, "new virtual rows have positions on their first frame")
  check(!document.querySelector("pre"), "closed tool outputs are unmounted")

  // Crossing the virtualization threshold remounts an already-open group.
  // Its measured height must replace the estimate before sibling rows paint.
  // Delayed delivery makes a busy renderer's height lag deterministic.
  const NativeResizeObserver = window.ResizeObserver
  window.ResizeObserver = class extends NativeResizeObserver {
    private pending = new Set<number>()
    constructor(callback: ResizeObserverCallback) {
      super((entries, observer) => {
        const timer = window.setTimeout(() => { this.pending.delete(timer); callback(entries, observer) }, 80)
        this.pending.add(timer)
      })
    }
    disconnect() { for (const timer of this.pending) window.clearTimeout(timer); this.pending.clear(); super.disconnect() }
  }
  const thresholdWork = [prompt, ...Array.from({ length: 12 }, (_, i) => tool(i)), tool(998, "Edit", false), ...Array.from({ length: 28 }, (_, i) => thought(`threshold-${i}`, "Thinking trace.", true))]
  publish(thresholdWork)
  await sleep(250)
  viewport().dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }))
  viewport().scrollTop = 0
  const group = document.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')
  check(group, "mixed group exists before virtualization")
  group?.click()
  await sleep(300)
  check(group?.getAttribute("aria-expanded") === "true", "mixed group is expanded before virtualization")
  let thresholdCollisions = 0
  for (let i = 0; i < 4; i++) {
    publish([...thresholdWork, ...(i % 2 === 0 ? [tool(999, "Edit", false)] : [])])
    for (let j = 0; j < 20; j++) { await frame(); thresholdCollisions += overlaps().length }
    await sleep(250)
  }
  publish([...thresholdWork, tool(999, "Edit", false)])
  await sleep(300)
  for (let i = 0; i < 4; i++) {
    const trigger = document.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')
    trigger?.click()
    for (let j = 0; j < 20; j++) { await frame(); thresholdCollisions += overlaps().length }
  }
  checks.thresholdCollisions = thresholdCollisions
  check(thresholdCollisions === 0, "expanded work has no overlap across virtualization thresholds")
  window.ResizeObserver = NativeResizeObserver

  // Many previous reasoning/tool segments in one live turn, then deltas to its tail.
  const work = Array.from({ length: 600 }, (_, i) => [thought(`reason-${i}`, "Settled reasoning. ".repeat(100), true), tool(i)]).flat()
  publish([prompt, ...work, thought("tail", "Live tail. ")])
  await sleep(300)
  if (!viewport()) throw new Error(`Missing viewport: ${document.body.innerHTML.slice(0, 2000)}`)
  viewport().scrollTop = viewport().scrollHeight
  await sleep(150)
  checks.mountedNodes = document.querySelectorAll("*").length
  const frames: number[] = [], commits: number[] = [], input: number[] = []
  let text = "Live tail. "
  let previous = await frame()
  const timer = setInterval(() => {
    const start = performance.now()
    document.getElementById("typing-probe")!.dispatchEvent(new InputEvent("input", { bubbles: true, data: "x" }))
    requestAnimationFrame(() => input.push(performance.now() - start))
  }, 80)
  const start = performance.now()
  while (performance.now() - start < 2400) {
    text += "More reasoning from the provider. "
    const commit = performance.now()
    publish([...blocks.slice(0, -1), thought("tail", text)])
    commits.push(performance.now() - commit)
    const now = await frame(); frames.push(now - previous); previous = now
  }
  clearInterval(timer)
  checks.commitP95 = p95(commits)
  checks.frameP95 = p95(frames)
  checks.inputFrameP95 = p95(input)
  check(p95(commits) < 25 && p95(frames) < 50 && p95(input) < 50, "active work stays responsive")
  check(overlaps().length === 0, "streaming mixed work has no overlap")
  // Stream through the real store as the transport does, including the thread
  // record. Presentation-only fixtures with thread:null miss chrome fan-out.
  const thread = { id: "fixture", project_id: "project", title: "Fixture", provider: { kind: "omp" as const, instance: "default" }, model: null, effort: null, permission_mode: "full-access" as const, status: "running" as const, cwd: "/project", worktree: null, provider_session_id: null, pinned: false, created_at: at, updated_at: at, last_seq: 0 }
  useStore.getState().set({ threads: { fixture: thread }, transcripts: { fixture: { ...emptyThreadState(), loaded: true, thread, blocks: [prompt] } } })
  let chromeUpdates = 0
  const unsubscribe = useStore.subscribe((next, prev) => { if (next.threads !== prev.threads) chromeUpdates++ })
  for (let i = 1; i <= 100; i++) useStore.getState().receiveEvent({ thread_id: "fixture", turn_id: "work", seq: i, at, kind: "assistant_thinking_delta", message_id: "stream", origin, delta: "More thinking. " })
  unsubscribe()
  checks.chromeUpdatesFor100Deltas = chromeUpdates
  check(chromeUpdates === 0, "text deltas do not invalidate thread chrome")
  check(useStore.getState().transcripts.fixture?.lastSeq === 100, "stream sequence stays exact")
  const native = window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }
  native.webkit.messageHandlers.bench.postMessage(JSON.stringify({ ...checks, failures, pass: failures.length === 0 }))
}
async function replay() {
  document.documentElement.classList.add("dark")
  useStore.getState().set({ selected: { kind: "thread", id: "fixture" }, splitView: null })
  publish([])
  flushSync(() => createRoot(document.getElementById("root")!).render(
    <ThemeProviderContext value={{ theme: "dark", translucent: false, setTheme: () => {}, setTranslucent: () => {} }}>
      <div className="flex h-screen flex-col"><Transcript threadId="fixture" bottomInset={0} /></div>
    </ThemeProviderContext>,
  ))
  let state = { ...emptyThreadState(), loaded: true }
  const commits: number[] = [], frames: number[] = []
  let previous = await frame(), collisions = 0, peakNodes = 0, paints = 0
  for (let i = 0; i < __WORK_REPLAY__.length; i++) {
    const event = __WORK_REPLAY__[i]!
    state = applyEvent(state, event)
    if (event.kind.includes("tool_call") || event.kind === "assistant_message_completed" || i % 20 === 0) {
      const start = performance.now()
      flushSync(() => useStore.getState().set({ transcripts: { fixture: state } }))
      commits.push(performance.now() - start)
      if (paints % 35 === 0) {
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]'))
        buttons.at(-1)?.click()
      }
      const now = await frame(); frames.push(now - previous); previous = now
      const overlapping = overlaps().length
      collisions += overlapping
      peakNodes = Math.max(peakNodes, document.querySelectorAll("*").length)
      paints++
    }
  }
  const native = window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }
  native.webkit.messageHandlers.bench.postMessage(JSON.stringify({ paints, collisions, peakNodes, commitP95: p95(commits), frameP95: p95(frames), pass: collisions === 0 }))
}
(__WORK_REPLAY__.length ? replay() : run()).catch(error => {
  const native = window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }
  native.webkit.messageHandlers.bench.postMessage(JSON.stringify({ ...checks, failures, error: String(error), pass: false }))
})
