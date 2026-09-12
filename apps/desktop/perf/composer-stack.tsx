// Real thread/composer geometry, including simultaneous tasks, queue and requests.
// Synthetic state only: no daemon, private transcript or provider invocation.
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { ThreadView } from "../src/views/Thread"
import { SidebarProvider } from "../src/components/kit/sidebar"
import { ThemeProviderContext } from "../src/components/theme-context"
import { buildThemeCssVariables, DEFAULT_THEME_STATE } from "../src/lib/kit/theme/theme.logic"
import { useStore } from "../src/state/store"
import { emptyThreadState } from "../src/state/transcript"
import type { ApprovalRequest, AsyncQuestionRequest, RuntimeTask, Thread } from "../src/protocol"
import "../src/index.css"

declare const __COMPOSER_STACK_MODE__: Mode

const at = "2026-09-12T00:00:00Z"
const thread: Thread = { id: "thread", project_id: "project", title: "Composer panels", provider: { kind: "omp", instance: "default" }, model: null, effort: null, permission_mode: "full-access", status: "running", cwd: "/project", worktree: null, provider_session_id: null, pinned: false, created_at: at, updated_at: at, last_seq: 0 }
const task: RuntimeTask = { id: "task", thread_id: thread.id, origin_turn_id: "turn", started_seq: 1, updated_seq: 1, kind: "process", status: "running", title: "rtk proxy npm run dev", backgrounded: true, stats: {}, capabilities: { stop: false, background: false }, started_at: at, updated_at: at }
const question: AsyncQuestionRequest = { id: "question", questions: [{ title: "Which part of the layout should stay visible while the agent works?", options: ["Keep the question and its actions readable", "Keep the queued follow-up editable"] }] }
const approval: ApprovalRequest = { id: "approval", thread_id: thread.id, turn_id: "turn", tool_name: "Bash", summary: "Run development server", suggestions: [], created_at: at, input: { command: "rtk proxy npm run dev" } }
const blocking = { ...approval, tool_name: "request_user_input", input: { questions: [{ id: "layout", question: question.questions[0]!.title, options: [{ label: "Shared panel edges", description: "Keep the activity, queue, and question aligned." }, { label: "Separate actions", description: "Make the approval buttons easy to reach." }] }] } }
const queued = Array.from({ length: 12 }, (_, i) => ({ id: `queue-${i}`, thread_id: thread.id, queued_at: at, message: { parts: [{ type: "text" as const, text: "Please refine the expandable card and the segmented control’s animation, preserving the attached context." }, ...Array.from({ length: 9 }, (_, n) => ({ type: "mention" as const, name: `context-${n}.tsx`, path: `/project/context-${n}.tsx` }))] } }))
type Mode = "queue" | "async" | "blocking" | "approval" | "plan" | "connector" | "none"
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
const failures: string[] = []
const check = (ok: unknown, label: string) => { if (!ok && !failures.includes(label)) failures.push(label) }
const themeRoot = document.documentElement
const view = createRoot(document.getElementById("root")!)
function setTheme(variant: "dark" | "light", opaque = false) {
  themeRoot.classList.toggle("dark", variant === "dark")
  themeRoot.dataset.windowMaterial = opaque ? "opaque" : "translucent"
  themeRoot.dataset.runtime = "electron"
  themeRoot.dataset.platform = "macos"
  if (opaque) delete themeRoot.dataset.fullTranslucency
  else themeRoot.dataset.fullTranslucency = ""
  const built = buildThemeCssVariables({ codeThemeId: DEFAULT_THEME_STATE.codeThemeIds[variant], theme: DEFAULT_THEME_STATE.chromeThemes[variant] }, variant, { electron: true, isMac: true, systemUiFont: true })
  for (const [key, value] of Object.entries(built.variables)) themeRoot.style.setProperty(key, value)
  themeRoot.style.setProperty("--app-font-size-ui", "12px")
  themeRoot.style.setProperty("--app-font-size-ui-lg", "13px")
  themeRoot.style.setProperty("--app-font-size-ui-sm", "11px")
}
function update(mode: Mode, queueCount = 1, tasks = true, long = false) {
  const pending = mode === "blocking" ? blocking : mode === "approval" ? approval : mode === "plan" ? { ...approval, tool_name: "ExitPlanMode", input: { plan: "# Implementation plan\n\n" + "Review the changes and verify the layout.\n\n".repeat(60) } } : mode === "connector" ? { ...approval, tool_name: "mcp_elicitation", input: { message: "Allow access to the browser?", _meta: { codex_approval_kind: "mcp_tool_call", connector_name: "Browser", tool_params_display: [{ name: "app", value: "Safari" }], persist: ["session"] } } } : null
  flushSync(() => useStore.getState().set(state => ({
    runtimeTasks: { [thread.id]: tasks ? [task] : [] }, queued: { [thread.id]: queued.slice(0, queueCount) },
    transcripts: { [thread.id]: { ...state.transcripts[thread.id]!, pendingApprovals: pending ? [pending] : [], pendingQuestions: mode === "async" ? [{ ...question, questions: long ? Array.from({ length: 8 }, () => question.questions[0]!) : question.questions }] : [] } },
  })))
}
function panels() {
  return [...document.querySelectorAll<HTMLElement>(".composer-panel-section, .chat-composer-stacked-top:not(.composer-panel-stack), .t-border-beam")].filter((el, i, all) => all.indexOf(el) === i)
}
function geometry(label: string) {
  const items = panels(), rects = items.map(el => el.getBoundingClientRect())
  const stack = document.querySelector<HTMLElement>(".composer-panel-stack")
  if (stack && items.length) {
    const bounds = stack.getBoundingClientRect()
    check(bounds.top >= 45 && bounds.bottom <= document.getElementById("fixture-pane")!.getBoundingClientRect().bottom + 1, `${label}: stack stays inside thread`)
    check(getComputedStyle(stack, "::before").content !== "none", `${label}: shared material remains`)
    check(items.every(item => getComputedStyle(item, "::before").content === "none"), `${label}: no nested glass layers`)
  }
  for (let i = 1; i < items.length; i++) {
    check(Math.abs(rects[i]!.left - rects[0]!.left) < 1 && Math.abs(rects[i]!.right - rects[0]!.right) < 1, `${label}: shared panel width`)
    check(Math.abs(rects[i]!.top - rects[i - 1]!.bottom) < .6, `${label}: continuous non-overlapping seam`)
    check(parseFloat(getComputedStyle(items[i]!).borderTopLeftRadius) === 0, `${label}: no rounded interior corners`)
  }
  const shell = document.querySelector<HTMLElement>(".chat-composer-shell:not([data-empty-landing-controls])")!
  if (getComputedStyle(shell).display !== "none" && rects.length) check(Math.abs(shell.getBoundingClientRect().top - (stack?.getBoundingClientRect().bottom ?? rects.at(-1)!.bottom)) < 1, `${label}: composer meets final panel`)
  for (const item of items) check(item.scrollWidth <= item.clientWidth + 1, `${label}: no horizontal clipping`)
  const footer = document.querySelector<HTMLElement>(".question-panel-footer")
  if (footer) {
    const form = document.querySelector<HTMLElement>(".question-panel")!.getBoundingClientRect()
    const bounds = footer.getBoundingClientRect()
    check(bounds.bottom <= form.bottom + 1, `${label}: question actions fit`)
  }
}
function render(width: number, height = 720) {
  flushSync(() => view.render(<ThemeProviderContext value={{ theme: "dark", translucent: true, setTheme: () => {}, setTranslucent: () => {} }}><SidebarProvider><main id="fixture-pane" style={{ width, maxWidth: "100vw", height, maxHeight: "100dvh", marginInline: "auto", position: "relative", background: "var(--background)" }}><ThreadView threadId={thread.id} showSidebarControls={false} /></main></SidebarProvider></ThemeProviderContext>))
}
function button(text: string) { return [...document.querySelectorAll<HTMLButtonElement>("button")].find(el => el.textContent?.trim() === text)! }
async function run() {
  useStore.getState().set({ connection: { state: "open" }, projects: { project: { id: "project", name: "Project", path: "/project", is_git: false, worktrees_default: false, created_at: at, updated_at: at } }, threads: { [thread.id]: thread }, providers: [], selected: { kind: "thread", id: thread.id }, splitView: null, transcripts: { [thread.id]: { ...emptyThreadState(), loaded: true, thread } } })
  let samples = 0
  for (const variant of ["dark", "light"] as const) for (const width of [1000, 480, 320]) {
    setTheme(variant)
    render(width)
    for (const mode of ["queue", "async", "blocking", "approval", "plan", "connector"] as const) {
      update(mode)
      await sleep(300)
      check(panels().length === (mode === "queue" ? 2 : 3), `${variant}/${width}/${mode}: all sections mounted`)
      geometry(`${variant}/${width}/${mode}`); samples++
    }
  }
  setTheme("dark")
  render(900)
  for (const mode of ["none", "queue", "async", "blocking", "approval", "plan", "connector"] as const) {
    update(mode, mode === "queue" ? 1 : 0, false)
    await sleep(300)
    check(panels().length === (mode === "none" ? 0 : 1), `standalone/${mode}: expected section`)
    geometry(`standalone/${mode}`)
    samples++
  }
  update("none", 0, true)
  await sleep(300)
  geometry("activity alone")
  samples++
  update("queue")
  await sleep(300)
  button("Edit").click()
  await frame()
  const editor = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit queued prompt"]')!
  editor.focus()
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "A multiline edit\nwith the original context retained.")
  flushSync(() => editor.dispatchEvent(new Event("input", { bubbles: true })))
  update("async")
  await sleep(300)
  check(document.activeElement === editor && editor.value.includes("multiline"), "Question arrival preserves queued edit and focus")
  geometry("editing with question")
  update("async", 1, false)
  await frame()
  check(document.activeElement === editor, "Task completion preserves queued edit focus")
  button("Cancel").click()
  for (const count of [0, 1, 12]) {
    update("async", count, true, true)
    await sleep(300)
    geometry(`long request/${count} queued`)
  }
  for (const height of [360, 520, 720]) {
    render(480, height)
    for (const mode of ["async", "blocking", "approval", "plan", "connector"] as const) {
      update(mode, 12, true, true)
      await sleep(300)
      geometry(`short pane/${height}/${mode}`)
      const stack = document.querySelector<HTMLElement>(".composer-panel-stack")
      if (stack) {
        stack.scrollTop = stack.scrollHeight
        const action = [...stack.querySelectorAll<HTMLButtonElement>("button")].at(-1)!
        const rect = action.getBoundingClientRect()
        check(stack.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)), `${height}/${mode}: final action reachable`)
        stack.scrollTop = 0
      }
      samples++
    }
  }
  render(480)
  for (const opaque of [false, true]) for (const variant of ["light", "dark"] as const) {
    setTheme(variant, opaque)
    update("blocking")
    await sleep(300)
    themeRoot.dir = "rtl"
    geometry(`${variant}/${opaque ? "opaque" : "glass"}/rtl`)
    themeRoot.dir = "ltr"
    const stack = document.querySelector<HTMLElement>(".composer-panel-stack")!
    if (stack) check(parseFloat(getComputedStyle(stack).borderBottomLeftRadius) > 0 && getComputedStyle(stack).borderBottomWidth === "1px", "Blocking question closes the outer bottom edge")
  }
  setTheme("dark")
  render(400, 520)
  themeRoot.style.setProperty("--app-font-size-ui", "16px")
  themeRoot.style.setProperty("--app-font-size-ui-lg", "18px")
  themeRoot.style.setProperty("--app-font-size-ui-sm", "14px")
  update("async", 12, true, true)
  await sleep(300)
  geometry("larger UI text")
  samples++
  setTheme("dark")
  render(480)
  const preferences = ["prefers-reduced-transparency: reduce", "prefers-contrast: more", "prefers-reduced-motion: reduce"]
  for (const preference of preferences) {
    const rules: CSSMediaRule[] = []
    const visit = (entries: CSSRuleList) => { for (const rule of entries) { if (rule instanceof CSSMediaRule && rule.conditionText.replaceAll(" ", "").includes(preference.replaceAll(" ", ""))) rules.push(rule); else if ("cssRules" in rule) visit((rule as CSSGroupingRule).cssRules) } }
    for (const sheet of document.styleSheets) visit(sheet.cssRules)
    check(rules.length, `${preference}: override exists`)
    const saved = rules.map(rule => rule.media.mediaText)
    try {
      rules.forEach(rule => { rule.media.mediaText = "all" })
      update("async")
      await frame()
      geometry(preference)
      const stack = document.querySelector<HTMLElement>(".composer-panel-stack")
      if (stack && !preference.includes("motion")) check(getComputedStyle(stack, "::before").backdropFilter === "none", `${preference}: blur disabled`)
      if (preference.includes("motion")) check(panels().every(panel => getComputedStyle(panel).animationName === "none"), "Reduced motion disables panel entrance")
    } finally { rules.forEach((rule, i) => { rule.media.mediaText = saved[i]! }) }
  }
  // Inspect entrance at slowed frame positions, including replacement mid-entry.
  for (const mode of ["none", "approval", "async", "blocking", "queue"] as const) {
    update(mode, mode === "none" ? 0 : 1, mode !== "none")
    const animations = document.getAnimations().filter(animation => (animation as CSSAnimation).animationName === "t-panel-enter" || (animation as CSSAnimation).animationName === "composer-panel-enter")
    for (const progress of [0, .25, .5, .75, 1]) {
      for (const animation of animations) { animation.pause(); animation.currentTime = Number(animation.effect!.getTiming().duration) * progress }
      await frame()
      geometry(`entry/${mode}/${progress}`)
    }
  }
  for (const animation of document.getAnimations()) if (animation.playState === "paused") animation.finish()
  setTheme("dark")
  render(Math.min(innerWidth, 900), innerHeight)
  update(__COMPOSER_STACK_MODE__)
  await sleep(400)
  const post = (value: unknown) => (window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }).webkit.messageHandlers.bench.postMessage(JSON.stringify(value))
  post({ pass: failures.length === 0, samples, failures })
}
run().catch(error => (window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }).webkit.messageHandlers.bench.postMessage(JSON.stringify({ pass: false, error: String(error), failures })))
