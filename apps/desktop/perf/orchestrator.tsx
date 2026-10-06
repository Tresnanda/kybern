/* eslint-disable @typescript-eslint/no-explicit-any, react-refresh/only-export-components */
// Orchestrator V2 in the real shell: the Lineage dock, delegation and message rows in a transcript,
// inbound messages, the held-message panel and the Delegation settings. Synthetic state; the
// runtime below answers the few RPCs the views make. Named screenshots go to KYBERN_PERF_SHOTS_DIR.
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { ThreadView } from "../src/views/Thread"
import { RightPanel } from "../src/views/RightPanel"
import { SettingsScreen } from "../src/views/SettingsScreen"
import { ThreadSidebar } from "../src/views/Sidebar"
import { Sidebar, SidebarProvider } from "../src/components/kit/sidebar"
import { TooltipProvider } from "../src/components/kit/tooltip"
import { ThemeProviderContext } from "../src/components/theme-context"
import { buildThemeCssVariables, DEFAULT_THEME_STATE } from "../src/lib/kit/theme/theme.logic"
import { setEnvironmentRuntime } from "../src/state/rpc"
import { recordThreadMessage } from "../src/state/threadMessages"
import { useStore } from "../src/state/store"
import { useEnvironments } from "../src/state/environments"
import { emptyThreadState } from "../src/state/transcript"
import { formBlocks, held, mainBlocks, projects, providers, resolvedRecord, sentRecords, threads } from "./orchestrator-data"
import "../src/index.css"

declare const __ORCH_THEME__: "dark" | "light"
const query = new URLSearchParams(location.search)
const theme = (query.get("theme") ?? __ORCH_THEME__) === "light" ? "light" : "dark"
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const post = (value: unknown) => (window as any).webkit?.messageHandlers?.bench?.postMessage(JSON.stringify(value))
const checks: Record<string, boolean> = {}
const check = (name: string, value: unknown) => { checks[name] = !!value }
const results = (value: unknown) => { ((window as any).__orchestratorResults ??= []).push(value); post(value) }
/** Ask the native runner for a named screenshot; it resumes this page when the file is written. */
const shot = (name: string) => new Promise<void>((resolve) => {
  // A window that is not frontmost reports itself hidden and stalls CSS animations at their first frame, which leaves
  // entering rows transparent. Finish the finite ones so every snapshot shows settled content.
  for (const animation of document.getAnimations()) {
    try { if (animation.effect?.getComputedTiming().iterations !== Infinity) animation.finish() } catch { /* not finishable */ }
  }
  ;(window as any).__screenshotContinue = resolve
  post({ screenshot: `${name}-${theme}` })
})
const visible = (element: Element | null | undefined): element is HTMLElement => !!element && (element as HTMLElement).getClientRects().length > 0 && !element.closest('[aria-hidden="true"], [inert]')

const calls: { method: string; params: any }[] = []
let heldRecords = held.map((record) => ({ ...record }))
const connection = {
  status: "open",
  onNotification: () => () => {},
  onStatus: () => () => {},
  async call(method: string, params: any): Promise<any> {
    calls.push({ method, params: structuredClone(params) })
    const state = useStore.getState()
    if (method === "queue.list") return { messages: [] }
    if (method === "providers.list") return { providers }
    if (method === "skills.list") return { skills: [] }
    if (method === "terminals.list") return { terminals: [] }
    if (method === "harness_updates.list") return { updates: [] }
    if (method === "daemon.activity") return { live_sessions: 3, idle_sessions: 1, terminals: 2, connections: 1, queued_messages: 0 }
    if (method === "threads.search") return { threads: [], next_cursor: null }
    if (method === "threads.messages.list") return { messages: params.thread_id === "main" ? sentRecords.map((record) => ({ ...record })) : [] }
    if (method === "threads.messages.deliver" || method === "threads.messages.dismiss") {
      const record = heldRecords.find((item) => item.id === params.message_id)!
      heldRecords = heldRecords.filter((item) => item.id !== params.message_id)
      return { ...record, state: method.endsWith("deliver") ? "queued" : "dismissed" }
    }
    if (method === "delegations.worktree_remove") {
      const current = state.threads[params.thread_id]!
      return { ...current, delegation: { ...current.delegation!, worktree_state: "removed" }, worktree: null }
    }
    if (method === "threads.interrupt") {
      const current = state.threads[params.thread_id]!
      state.set({ threads: { ...state.threads, [current.id]: { ...current, status: "idle", delegation: current.delegation ? { ...current.delegation, status: "cancelled", completed_at: new Date().toISOString() } : current.delegation } } })
      return {}
    }
    if (method === "settings.update") { state.set({ settings: params.settings }); return params.settings }
    throw new Error(`Unexpected orchestrator fixture RPC: ${method}`)
  },
}
const noop = async () => undefined
const runtime: any = new Proxy({
  rpc: () => connection,
  loadThread: async (id: string) => {
    const current = useStore.getState()
    if (!current.transcripts[id]) current.set((state) => ({ transcripts: { ...state.transcripts, [id]: { ...emptyThreadState(), loaded: true, thread: state.threads[id] } } }))
  },
  loadLineage: noop,
  loadSubagents: noop,
  loadHeldMessages: noop,
  retainToolOutput: () => () => {},
  interrupt: (id: string) => connection.call("threads.interrupt", { thread_id: id }),
  archiveThread: noop,
  subscribeCollaboration: () => () => {},
  searchFiles: async () => [],
  listSkills: async () => [],
}, { get: (target, key) => (key in target ? (target as any)[key] : noop) })

function Shell() {
  const selected = useStore((state) => state.selected)
  const rightOpen = useStore((state) => state.rightOpen)
  const id = selected.kind === "thread" ? selected.id : "main"
  return (
    <ThemeProviderContext value={{ theme, translucent: false, setTheme: () => {}, setTranslucent: () => {} }}>
      <TooltipProvider>
        <SidebarProvider>
          <Sidebar><ThreadSidebar /></Sidebar>
          <main className="flex h-screen min-w-0 flex-1 flex-col"><ThreadView key={id} threadId={id} /></main>
          {rightOpen && <aside className="h-screen w-[440px] border-s border-[color:var(--app-surface-divider)]"><RightPanel threadId={id} /></aside>}
        </SidebarProvider>
      </TooltipProvider>
    </ThemeProviderContext>
  )
}

function applyTheme() {
  const root = document.documentElement
  root.classList.toggle("dark", theme === "dark"); root.dataset.themeVariant = theme; root.dataset.runtime = "electron"; root.dataset.platform = "macos"
  // An opaque window keeps the snapshot honest: the composer stack must read on its own surface.
  root.dataset.windowMaterial = "opaque"
  const built = buildThemeCssVariables({ codeThemeId: DEFAULT_THEME_STATE.codeThemeIds[theme], theme: DEFAULT_THEME_STATE.chromeThemes[theme] }, theme, { electron: true, isMac: true, systemUiFont: true })
  for (const [key, value] of Object.entries(built.variables)) root.style.setProperty(key, value)
}

const row = (threadId: string) => document.querySelector<HTMLElement>(`[data-lineage-row="${threadId}"]`)
async function toggleDetail(threadId: string) {
  row(threadId)?.querySelector<HTMLButtonElement>("button[aria-expanded]:not([aria-label^='Collapse']):not([aria-label^='Expand'])")?.click()
  await sleep(320)
}
function scrollTranscript(to: "top" | "end" | HTMLElement) {
  const scroller = document.querySelector<HTMLElement>('[data-slot="message-scroller"]')
  const element = scroller && [scroller, ...scroller.querySelectorAll<HTMLElement>("*")].find((node) => node.scrollHeight > node.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(node).overflowY))
  if (!element) return
  if (to === "top") element.scrollTop = 0
  else if (to === "end") element.scrollTop = element.scrollHeight
  else element.scrollTop += to.getBoundingClientRect().top - element.getBoundingClientRect().top - 24
}

async function run() {
  applyTheme()
  setEnvironmentRuntime(runtime)
  useEnvironments.setState({ selectedId: "local", switching: false, profiles: [{ id: "local", name: "UI preview", url: null, environment_id: "fixture", hostname: "Local", local: true }] })
  const transcripts = Object.fromEntries(Object.values(threads).map((item) => [item.id, { ...emptyThreadState(), loaded: true, thread: item }])) as Record<string, any>
  transcripts.main.blocks = mainBlocks
  transcripts["c-form"].blocks = formBlocks
  useStore.getState().set({
    projects, threads, providers, selected: { kind: "thread", id: "main" }, splitView: null, transcripts, composerDrafts: {}, connection: { state: "open" },
    rightOpen: true, rightTabs: ["collaboration"], rightTab: "collaboration", envOpen: false, heldMessages: {}, messageRecords: {}, queued: {},
    settings: { default_provider: "codex", default_permission_mode: "supervised", worktrees_default: true, generate_titles: true, providers: {}, notifications: true, auto_update_harnesses: false, auto_update_daemon: false, background: { session_idle_minutes: 15, max_idle_sessions: 3, terminal_idle_minutes: 30, daemon_idle_exit_minutes: 0, save_power_on_battery: true }, access: { tailscale: false }, orchestration: { max_active_children: 4, max_depth: 2 } } as any,
  })
  const root = createRoot(document.getElementById("root")!, { onUncaughtError: (error) => results({ pass: false, error: String(error) }) })
  flushSync(() => root.render(<Shell />))
  await sleep(900)

  // 1. Lineage: the tree of mixed children, closed.
  const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-lineage-row]"))
  const kinds = rows.map((node) => node.dataset.lineageKind)
  check("lineage lists delegated, native and legacy children", kinds.includes("delegated") && kinds.includes("native") && kinds.includes("helper"))
  check("lineage nests the grandchild under its parent", !!row("g-review") && rows.findIndex((node) => node.dataset.lineageRow === "g-review") === rows.findIndex((node) => node.dataset.lineageRow === "c-form") + 1)
  check("lineage pane mounted for an ordinary thread", !!document.querySelector("[data-lineage-pane]"))
  check("sidebar nests the working children", !!document.querySelector("[data-subagent-row]"))
  check("delegation group folds four launches", document.querySelectorAll("[data-delegation-group]").length === 1)
  check("results card renders", !!document.querySelector("[data-agent-results]"))
  check("sent-to rows render", document.querySelectorAll("[data-sent-to]").length === 3)
  scrollTranscript("top"); await sleep(300)
  await shot("shell-top")
  scrollTranscript(document.querySelector<HTMLElement>("[data-agent-results]")!); await sleep(300)
  await shot("shell-results")
  scrollTranscript("end"); await sleep(300)
  await shot("shell-sent")
  const sent = (id: string) => document.querySelector<HTMLElement>(`[data-sent-message-id="${id}"]`)
  check("the records were listed once for the thread", calls.filter((call) => call.method === "threads.messages.list" && call.params.thread_id === "main").length === 1)
  check("a question answered after its call returned reads Answered with the reply", sent("m-1")?.dataset.sentState === "answered" && !!sent("m-1")?.textContent?.includes("Answered") && !!sent("m-1")?.textContent?.includes("Reply: “It sets formError"))
  check("a steered send reads Sent now", sent("m-2")?.dataset.sentState === "steered" && !!sent("m-2")?.textContent?.includes("Sent now"))
  check("a held send waits for approval", sent("m-3")?.dataset.sentState === "held" && !!sent("m-3")?.textContent?.includes("Held for approval") && !!sent("m-3")?.textContent?.includes("Waiting for you to approve"))
  // The reader approves it in the test agent's thread: the daemon reports the new state on this thread.
  recordThreadMessage("main", resolvedRecord); await sleep(450)
  check("a resolved hold shows its live state and stops asking", sent("m-3")?.dataset.sentState === "delivered" && !!sent("m-3")?.textContent?.includes("Delivered") && !sent("m-3")?.textContent?.includes("Waiting for you to approve") && !sent("m-3")?.textContent?.includes("Held for approval"))
  check("the other rows did not change", sent("m-1")?.dataset.sentState === "answered" && sent("m-2")?.dataset.sentState === "steered")
  await shot("shell-sent-resolved")

  // 2. Lineage detail: the working child with files and a conflict, then the worktree children.
  await toggleDetail("c-form"); await toggleDetail("c-session")
  check("detail mounts only when open", !!row("c-form")?.textContent?.includes("Files touched") && !row("c-kept")?.textContent?.includes("Files touched"))
  check("conflict names its owner", !!row("c-form")?.textContent?.includes("is owned by “Wire up the session store”"))
  const files = row("c-form")?.querySelector('[role="list"][aria-label^="Files touched"]')
  check("files touched is a list of list items without a ul wrapper", !!files && files.tagName === "DIV" && files.querySelectorAll('[role="listitem"]').length === 5 && !row("c-form")?.querySelector("ul > div"))
  await shot("lineage-working")
  await toggleDetail("c-form"); await toggleDetail("c-session")
  await toggleDetail("c-kept"); await toggleDetail("c-fail"); await toggleDetail("n-explore")
  check("kept worktree offers its removal", !!Array.from(row("c-kept")?.querySelectorAll("button") ?? []).find((button) => button.textContent?.includes("Remove worktree")))
  check("failed child leads with its error", !!row("c-fail")?.textContent?.includes("Playwright could not start"))
  check("native subagent is read-only and cannot be stopped", !!row("n-explore")?.textContent?.includes("Read-only") && !row("n-explore")?.querySelector("[aria-label^='Stop']"))
  await shot("lineage-settled")
  const remove = Array.from(row("c-kept")!.querySelectorAll("button")).find((button) => button.textContent?.includes("Remove worktree"))!
  remove.click(); await sleep(450)
  check("removal asks first", !!document.querySelector('[data-slot="alert-dialog-popup"]') && !calls.some((call) => call.method === "delegations.worktree_remove"))
  await shot("lineage-remove")
  Array.from(document.querySelectorAll<HTMLElement>('[data-slot="alert-dialog-popup"] button')).find((button) => button.textContent === "Remove worktree")!.click(); await sleep(400)
  check("confirming forces the removal", calls.some((call) => call.method === "delegations.worktree_remove" && call.params.force === true))
  check("the kept state clears", !document.body.textContent?.includes("Worktree kept") || !row("c-kept")?.textContent?.includes("Remove worktree"))
  // Stop one running child from its row.
  const stop = row("c-review")?.querySelector<HTMLButtonElement>("[aria-label^='Stop']")
  check("a running delegated child can be stopped", !!stop)
  stop?.click(); await sleep(250)
  check("stop interrupts only that child", calls.filter((call) => call.method === "threads.interrupt").length === 1 && calls.find((call) => call.method === "threads.interrupt")!.params.thread_id === "c-review")

  // 3. The form agent: inbound messages and the held panel.
  useStore.getState().set({ selected: { kind: "thread", id: "c-form" }, rightOpen: false, heldMessages: { "c-form": heldRecords }, queued: { "c-form": [{ id: "q-1", message: { parts: [{ type: "thread_message", message_id: "q-1", from_thread_id: "g-review", from_title: "Check the form for accessibility issues", purpose: "message", body: "The label for the password field is missing its `for` attribute." }] } as never }] } })
  await sleep(700)
  check("inbound purposes render", ["task", "question", "reply", "warning", "message"].every((purpose) => !!document.querySelector(`[data-inbound-message="${purpose}"]`)))
  check("a reply names the question it answers", !!document.body.textContent?.includes("Reply to “Should the form announce an error"))
  check("held actions name their message", ["Deliver question from", "Dismiss question from"].every((label) => Array.from(document.querySelectorAll('[data-testid="held-message-row"] button[aria-label]')).some((button) => button.getAttribute("aria-label")!.startsWith(label))))
  check("held messages wait in the composer stack", document.querySelectorAll('[data-testid="held-message-row"]').length === 2)
  check("queued structured message reads as an update", !!document.body.textContent?.includes("1 agent update waiting"))
  scrollTranscript("top"); await sleep(250)
  await shot("child-top")
  scrollTranscript("end"); await sleep(250)
  await shot("child-held")
  const deliver = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="held-message-row"] button')).find((button) => button.textContent === "Deliver")!
  deliver.click(); await sleep(350)
  check("deliver calls the daemon and the row leaves", calls.some((call) => call.method === "threads.messages.deliver" && call.params.message_id === "h-1") && document.querySelectorAll('[data-testid="held-message-row"]').length === 1)
  const dismiss = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="held-message-row"] button')).find((button) => button.textContent === "Dismiss")!
  dismiss.click(); await sleep(350)
  check("dismiss leaves no panel behind", calls.some((call) => call.method === "threads.messages.dismiss") && !document.querySelector("[data-held-messages]"))

  // 4. Settings: the delegation limits.
  useStore.getState().set({ settingsOpen: true, settingsTab: "agents" })
  flushSync(() => root.render(<TooltipProvider><ThemeProviderContext value={{ theme, translucent: false, setTheme: () => {}, setTranslucent: () => {} }}><SettingsScreen /></ThemeProviderContext></TooltipProvider>))
  await sleep(500)
  const depth = document.querySelector<HTMLInputElement>('input[aria-label="Delegation depth"]')
  const active = document.querySelector<HTMLInputElement>('input[aria-label="Active agents per thread"]')
  check("delegation limits are in Agent providers", !!depth && !!active && visible(depth))
  if (active) {
    active.scrollIntoView({ block: "center" })
    const set = (value: string) => { active.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(active, value); active.dispatchEvent(new Event("input", { bubbles: true })); active.blur() }
    set("40"); await sleep(120)
    check("active agents clamp to 16", useStore.getState().settings?.orchestration.max_active_children === 16)
    set(""); await sleep(120)
    check("an empty limit keeps the saved value", useStore.getState().settings?.orchestration.max_active_children === 16 && active.value === "16")
    set("4"); await sleep(120)
  }
  document.querySelector<HTMLElement>(".settings-scroll")?.scrollTo({ top: 0 })
  await shot("settings-delegation")
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name)
  results({ pass: failed.length === 0, failed, checks, theme })
}
void run().catch((error) => results({ pass: false, error: String(error), checks }))
