// Native WebKit regression fixture (ADE-43): a visual in a running turn must not shift while
// live-work rows above it appear, merge and disappear, and inline frames must not be re-themed
// or clipped without cause. Production Transcript + VisualReply + the daemon's bootstrap.
//
// Positions are sampled at the top of each animation frame, before this fixture's own updates for
// that frame, so a sample is exactly what the previous frame painted. A correction deferred to the
// next frame therefore shows up as a one-sample displacement; a same-frame one never does.
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { Transcript } from "../src/views/Transcript"
import { useStore } from "../src/state/store"
import { applyEvent, emptyThreadState } from "../src/state/transcript"
import { ThemeProviderContext } from "../src/components/theme-context"
import { buildThemeCssVariables, DEFAULT_THEME_STATE } from "../src/lib/kit/theme/theme.logic"
import type { ThreadEvent, RuntimeTask } from "../src/protocol"
import "../src/index.css"

const root = createRoot(document.getElementById("root")!)
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const report = (value: unknown) => (window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }).webkit.messageHandlers.bench.postMessage(JSON.stringify(value))
const failures: string[] = []
function expect(ok: boolean, label: string) { if (!ok) failures.push(label); report({ stage: "check", ok, label }) }

const T = "fixture"
let state = { ...emptyThreadState(), loaded: true }
let seq = 0
let clock = Date.parse("2026-10-12T00:00:00Z")
const at = () => new Date(clock += 1000).toISOString()
const uid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`
let ids = 100
function publish(event: Partial<ThreadEvent> & { kind: string }) {
  const full = { seq: ++seq, thread_id: T, at: at(), ...event } as ThreadEvent
  state = applyEvent(state, full)
  const task = (full as { task?: RuntimeTask }).task
  if (task) {
    const current = useStore.getState().runtimeTasks[T] ?? []
    const next = current.some(item => item.id === task.id) ? current.map(item => item.id === task.id ? task : item) : [...current, task]
    flushSync(() => useStore.getState().set({ transcripts: { [T]: state }, runtimeTasks: { ...useStore.getState().runtimeTasks, [T]: next } }))
  } else flushSync(() => useStore.getState().set({ transcripts: { [T]: state } }))
}
const userTurn = (turn: string, text: string) => publish({ kind: "turn_started", turn_id: turn, message_id: uid(ids++), message: { parts: [{ type: "text", text }] } } as never)
function answer(turn: string, text: string) {
  const message = uid(ids++)
  publish({ kind: "assistant_message_completed", turn_id: turn, message_id: message, origin: { kind: "root" }, text, thinking: null } as never)
  publish({ kind: "turn_completed", turn_id: turn, stop_reason: "completed", usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0 }, cost_usd: null, duration_ms: 4000, terminal_message_id: message } as never)
}
function agentTask(turn: string, n: number, extra: Partial<RuntimeTask> = {}): RuntimeTask {
  return { id: "agent-task", thread_id: T, origin_turn_id: turn, started_seq: 1, updated_seq: seq + 1, kind: "agent", status: "running", title: "Routing review", detail: `Step ${n}`, provider_type: "sub_agent", tool_call_id: "agent-task-call", provider_thread_id: "agent-task-child", backgrounded: true, last_tool_name: n % 2 ? "Read" : "Search", stats: { tool_uses: n }, capabilities: { stop: true, background: false }, started_at: "2026-10-12T00:00:00Z", updated_at: at(), ...extra } as unknown as RuntimeTask
}
/** Live work in a running turn: a root command row appears, completes and folds into "Ran N commands",
 * and the background agent's row alternates between a short and a wrapped detail. */
function agentStep(turn: string, n: number) {
  if (n % 2) publish({ kind: "tool_call_started", turn_id: turn, origin: { kind: "root" }, call: { id: `cmd-${n}`, name: "Bash", input: { command: "sleep 1" }, parent_id: null } } as never)
  else publish({ kind: "tool_call_completed", turn_id: turn, tool_call_id: `cmd-${n - 1}`, output: { content: "ok" }, is_error: false } as never)
  if (n % 4 === 0) publish({ kind: "runtime_task_updated", turn_id: turn, task: agentTask(turn, n, n % 8 ? { detail: null, last_tool_name: null } : { detail: `Reading file${n}.ts with a longer description that may wrap across lines in the row` }) } as never)
}
function appearance(variant: "dark" | "light") {
  const element = document.documentElement
  element.classList.toggle("dark", variant === "dark")
  const built = buildThemeCssVariables({ codeThemeId: DEFAULT_THEME_STATE.codeThemeIds[variant], theme: DEFAULT_THEME_STATE.chromeThemes[variant] }, variant, { electron: true, isMac: true, systemUiFont: true })
  for (const [key, value] of Object.entries(built.variables)) element.style.setProperty(key, value)
}
async function screenshot(name: string) {
  await new Promise<void>(resolve => { (window as unknown as { __screenshotContinue: () => void }).__screenshotContinue = resolve; report({ screenshot: name }) })
}

let inset = 0
function mount() {
  flushSync(() => root.render(<ThemeProviderContext value={{ theme: document.documentElement.classList.contains("dark") ? "dark" : "light", translucent: false, setTheme: () => {}, setTranslucent: () => {} }}>
    <div id="stage" style={{ width: 900, height: 700 }} className="flex flex-col bg-[var(--color-background-surface)]"><Transcript threadId={T} bottomInset={inset} /></div>
  </ThemeProviderContext>))
}
const scroller = () => document.querySelector<HTMLElement>("[data-chat-scroll-container]")!
const visualBox = () => document.querySelector<HTMLElement>("[data-visual-reply]")
const userMessage = (text: string) => [...document.querySelectorAll<HTMLElement>('[data-message-role="user"]')].find(element => element.textContent?.includes(text))
async function waitReady(count = 1) {
  const until = performance.now() + 8000
  while (performance.now() < until) {
    if ([...document.querySelectorAll<HTMLElement>("[data-visual-reply]")].filter(box => box.dataset.status === "ready").length >= count) return
    await sleep(30)
  }
  report({ stage: "not-ready", boxes: [...document.querySelectorAll<HTMLElement>("[data-visual-reply]")].map(box => ({ status: box.dataset.status, src: box.querySelector("iframe")?.src, error: box.textContent })) })
  expect(false, "visual reached ready")
}

// ---------- frame-driven phases ----------
interface Sampled { name: string; frames: number; visualJumps: number; visualMax: number; anchorJumps: number; anchorMax: number; endGapMax: number; endGapFrames: number; heightChanges: number }
/** Runs `update` once per frame after sampling what the previous frame painted. */
async function phase(name: string, ms: number, anchor: string | null, update?: (elapsed: number, frame: number) => void): Promise<Sampled> {
  const result: Sampled = { name, frames: 0, visualJumps: 0, visualMax: 0, anchorJumps: 0, anchorMax: 0, endGapMax: 0, endGapFrames: 0, heightChanges: 0 }
  let lastVisual = NaN, lastAnchor = NaN, lastHeight = NaN
  const start = performance.now()
  await new Promise<void>(resolve => {
    const tick = () => {
      const elapsed = performance.now() - start
      const visual = visualBox()?.getBoundingClientRect().top ?? NaN
      const target = anchor ? userMessage(anchor)?.getBoundingClientRect().top ?? NaN : NaN
      const view = scroller()
      const gap = Math.abs(view.scrollHeight - view.scrollTop - view.clientHeight - restGap)
      if (result.frames > 0) {
        if (Math.abs(visual - lastVisual) >= .5) { result.visualJumps++; result.visualMax = Math.max(result.visualMax, Math.abs(visual - lastVisual)) }
        if (Math.abs(target - lastAnchor) >= .5) { result.anchorJumps++; result.anchorMax = Math.max(result.anchorMax, Math.abs(target - lastAnchor)) }
      }
      if (gap >= 1) result.endGapFrames++
      if (view.scrollHeight !== lastHeight && !Number.isNaN(lastHeight)) result.heightChanges++
      lastHeight = view.scrollHeight
      result.endGapMax = Math.max(result.endGapMax, gap)
      lastVisual = visual; lastAnchor = target; result.frames++
      if (elapsed >= ms) return resolve()
      update?.(elapsed, result.frames)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  report({ stage: "phase", ...result })
  return result
}
/** Distance from the scroll end while following at rest; the content keeps its composer padding below the last row. */
let restGap = 0

// ---------- frame probes ----------
const frameReports = new Map<string, Record<string, any>>() // eslint-disable-line @typescript-eslint/no-explicit-any
window.addEventListener("message", event => { if (event.data?.fixture === "bounce-report") frameReports.set(event.data.id, event.data) })
const sizePosts = new Map<Window, number[]>()
window.addEventListener("message", event => { if (event.data?.kind === "kybern-visual-size" && event.source) { const list = sizePosts.get(event.source as Window) ?? []; list.push(event.data.height); sizePosts.set(event.source as Window, list) } })
async function probe(page: string) {
  const frame = [...document.querySelectorAll<HTMLIFrameElement>("[data-visual-reply] iframe")].find(element => element.title === `Visual ${page}`)
  if (!frame) return undefined
  frameReports.delete(page); frame.contentWindow!.postMessage({ fixture: "bounce-probe" }, "*")
  const until = performance.now() + 2000
  while (!frameReports.has(page) && performance.now() < until) await sleep(20)
  return frameReports.get(page)
}
function reset() {
  state = { ...emptyThreadState(), loaded: true }; seq = 0
  flushSync(() => useStore.getState().set({ transcripts: { [T]: state }, runtimeTasks: {} }))
  root.render(null)
}

async function run() {
  appearance("dark"); document.body.style.background = "var(--color-background-surface)"
  const until = performance.now() + 5000
  while (document.hidden && performance.now() < until) await sleep(50)
  expect(!document.hidden, "window is visible (set KYBERN_PERF_FOREGROUND=1)")
  reset(); await sleep(50); mount()

  // Earlier history, then a turn that is still running: a delegated agent, a chart, and live work above it.
  for (let i = 0; i < 6; i++) { const turn = uid(ids++); userTurn(turn, `Earlier question ${i}`); answer(turn, `Earlier answer ${i}. `.repeat(30)) }
  const turn = uid(ids++)
  const PROMPT = "Delegate a review and chart the results"
  userTurn(turn, PROMPT)
  publish({ kind: "tool_call_started", turn_id: turn, origin: { kind: "root" }, call: { id: "agent-task-call", name: "Agent", input: { prompt: "Inspect", description: "Review routing" }, parent_id: null } } as never)
  publish({ kind: "runtime_task_started", turn_id: turn, task: agentTask(turn, 0) } as never)
  publish({ kind: "html_published", turn_id: turn, visual: { id: "run-basic", title: "Visual basic", height: 600 } } as never)
  await waitReady(); await sleep(900)
  const view = scroller()
  restGap = view.scrollHeight - view.scrollTop - view.clientHeight
  report({ stage: "geometry", scrollTop: view.scrollTop, scrollHeight: view.scrollHeight, clientHeight: view.clientHeight, restGap })

  // 1. Following the end while live-work rows above the visual appear, fold and merge every ~450 ms.
  let step = 0, next = 0
  const work = (elapsed: number) => { if (elapsed >= next) { next = elapsed + 450; agentStep(turn, ++step) } }
  const following = await phase("following", 6000, null, work)
  expect(following.heightChanges > 5, `the scenario changes the content height (${following.heightChanges} changes)`)
  expect(following.visualJumps === 0, `visual stays put while following (jumps ${following.visualJumps}, max ${following.visualMax.toFixed(1)}px)`)
  expect(following.endGapFrames === 0, `end stays pinned while following (off-end frames ${following.endGapFrames}, max ${following.endGapMax.toFixed(1)}px)`)

  // 2. A reader scrolled away from the end: the live work changes, earlier content must not move.
  view.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }))
  view.scrollTop = Math.max(0, view.scrollTop - 180)
  await sleep(300)
  next = 0
  const reading = await phase("reading", 4000, PROMPT, work)
  expect(reading.anchorJumps === 0, `earlier content stays put while reading (jumps ${reading.anchorJumps}, max ${reading.anchorMax.toFixed(1)}px)`)

  // 3. The model's text arrives but the turn keeps running (a background agent): more live work, now after prose.
  view.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true }))
  view.scrollTop = view.scrollHeight
  await sleep(300)
  publish({ kind: "assistant_message_completed", turn_id: turn, message_id: uid(ids++), origin: { kind: "root" }, text: "The agent keeps reviewing in the background. ".repeat(3), thinking: null } as never)
  await sleep(600)
  restGap = view.scrollHeight - view.scrollTop - view.clientHeight
  next = 0
  const background = await phase("background-agent", 5000, null, work)
  expect(background.heightChanges > 3, `the background agent changes the content height (${background.heightChanges} changes)`)
  expect(background.visualJumps === 0, `visual stays put under a background agent (jumps ${background.visualJumps}, max ${background.visualMax.toFixed(1)}px)`)
  expect(background.endGapFrames === 0, `end stays pinned under a background agent (off-end frames ${background.endGapFrames}, max ${background.endGapMax.toFixed(1)}px)`)
  answer(turn, "Done.")

  // 4. Composer-style ancestor changes (padding, a CSS variable) are not theme changes.
  const before = await probe("basic")
  let frameNo = 0
  await phase("inset", 1500, null, () => { frameNo++; inset = 120 + (frameNo % 12) * 5; mount() })
  inset = 0; mount(); await sleep(300)
  const after = await probe("basic")
  const themeWrites = (after?.themeWrites ?? 0) - (before?.themeWrites ?? 0)
  const themeMessages = (after?.themeMsgs ?? 0) - (before?.themeMsgs ?? 0)
  const hostMessages = (after?.hostMsgs ?? 0) - (before?.hostMsgs ?? 0)
  report({ stage: "theme-churn", themeWrites, themeMessages, hostMessages })
  expect(themeWrites === 0, `ancestor style changes do not rewrite the frame theme (${themeWrites} writes)`)
  expect(themeMessages === 0, `ancestor style changes do not re-send the theme (${themeMessages} messages)`)
  expect(hostMessages <= 2, `ancestor style changes send almost no host messages (${hostMessages})`)

  // 5. A real appearance change still reaches the frame.
  const frame = document.querySelector<HTMLIFrameElement>("iframe[title='Visual basic']")!
  const paint = async () => { await sleep(500); return (await probe("basic")) }
  const darkBackground = getComputedStyle(frame).colorScheme
  appearance("light"); await paint()
  const lightBackground = getComputedStyle(frame).colorScheme
  expect(darkBackground === "dark" && lightBackground === "light", `appearance change reaches the frame (${darkBackground} -> ${lightBackground})`)
  appearance("dark"); await paint()

  // 6. Pages measure their whole document, including margins that collapse through body.
  reset(); await sleep(50); mount()
  const second = uid(ids++)
  userTurn(second, "Show the pages")
  publish({ kind: "html_published", turn_id: second, visual: { id: "run-margins", title: "Visual margins", height: 600 } } as never)
  publish({ kind: "html_published", turn_id: second, visual: { id: "run-scroll", title: "Visual scroll", height: 600 } } as never)
  answer(second, "Both pages are above.")
  await waitReady(2); await sleep(900)
  const margins = await probe("margins")
  const marginsFrame = document.querySelector<HTMLIFrameElement>("iframe[title='Visual margins']")!
  const posted = sizePosts.get(marginsFrame.contentWindow!)?.at(-1) ?? 0
  const boxHeight = marginsFrame.parentElement!.getBoundingClientRect().height
  report({ stage: "margins", margins, posted, boxHeight })
  expect(!!margins && margins.docScrollHeight <= margins.innerHeight, `collapsed margins do not make the page scroll (scrollHeight ${margins?.docScrollHeight}, viewport ${margins?.innerHeight})`)
  expect(!!margins && margins.rootHeight - margins.bodyHeight > 60, `fixture page really collapses its margins (root ${margins?.rootHeight}, body ${margins?.bodyHeight})`)
  expect(Math.abs(boxHeight - Math.ceil(margins?.rootHeight ?? 0)) <= 1, `box height is the whole document (${boxHeight} vs ${margins?.rootHeight})`)

  // 7. Scrollbars inside a page: thin, themed, and never over a page's own styles.
  const scrolls = await probe("scroll")
  report({ stage: "bars", bars: scrolls?.bars })
  const bar = (id: string) => scrolls?.bars.find((entry: { id: string }) => entry.id === id)
  expect(bar("pre")?.x === 10 && bar("list")?.y === 10, `page scrollers get the 10px app scrollbar (pre ${bar("pre")?.x}px, list ${bar("list")?.y}px)`)
  expect(bar("own")?.x === 4 && bar("own")?.y === 4, `a page's own scrollbar styles still win (${bar("own")?.x}px, ${bar("own")?.y}px)`)
  scroller().scrollTop = 0
  await sleep(300)
  await screenshot("scrollbars-dark")
  appearance("light"); await sleep(800)
  await screenshot("scrollbars-light")
  appearance("dark"); await sleep(300)

  return { pass: failures.length === 0, failures, following: { jumps: following.visualJumps, max: following.visualMax, frames: following.frames, offEnd: following.endGapFrames }, background: { jumps: background.visualJumps, max: background.visualMax }, reading: { jumps: reading.anchorJumps, frames: reading.frames } }
}
run().then(report).catch(error => report({ pass: false, error: String(error), stack: error?.stack }))
