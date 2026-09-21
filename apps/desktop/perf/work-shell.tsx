// Compare sequence-only thread publication with the scoped store, using the
// actual sidebar, thread header, composer and transcript. No provider is called.
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { ThreadView } from "../src/views/Thread"
import { ThreadSidebar } from "../src/views/Sidebar"
import { Sidebar, SidebarProvider } from "../src/components/kit/sidebar"
import { ThemeProviderContext } from "../src/components/theme-context"
import { useStore } from "../src/state/store"
import { selectAttentionItems } from "../src/state/notifications"
import { emptyThreadState } from "../src/state/transcript"
import { FREE_CHAT_PROJECT_ID, type Thread, type Project } from "../src/protocol"
import "../src/index.css"
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const frame = () => new Promise<number>(resolve => requestAnimationFrame(resolve))
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * .95)] ?? 0
// Focused functional check for unattended windows whose rAF is suspended.
// It intentionally emits no rendering-performance samples.
const notificationsOnly = import.meta.env.VITE_NOTIFICATIONS_ONLY === "1"
const at = new Date(Date.now() - 2 * 60_000).toISOString()
const origin = { kind: "root" } as const
const projects: Record<string, Project> = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`project-${i}`, { id: `project-${i}`, name: `Project ${i}`, path: "/project", is_git: false, worktrees_default: false, created_at: at, updated_at: at }]))
const threads: Record<string, Thread> = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`thread-${i}`, { id: `thread-${i}`, project_id: `project-${i % 20}`, title: `Thread ${i}`, provider: { kind: i === 0 ? "codex" : "omp", instance: "default" }, model: null, effort: null, permission_mode: "full-access", status: i === 0 ? "running" : "idle", cwd: "/project", worktree: null, provider_session_id: i === 0 ? "fixture-session" : null, pinned: false, created_at: at, updated_at: at, last_seq: 0 }]))
threads["thread-free"] = { ...threads["thread-1"]!, id: "thread-free", project_id: FREE_CHAT_PROJECT_ID, title: "Plan a weekend trip", cwd: "/free-chat", updated_at: new Date().toISOString() }
threads["thread-999"] = { ...threads["thread-999"]!, parent_thread_id: "thread-0" }
threads["thread-998"] = { ...threads["thread-998"]!, status: "failed", last_seq: 12 }
threads["thread-997"] = { ...threads["thread-997"]!, status: "awaiting-approval", last_seq: 15 }
const native = () => (window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }).webkit.messageHandlers.bench
async function run() {
  document.documentElement.classList.add("dark")
  useStore.getState().set({
    projects,
    threads,
    providers: [],
    selected: { kind: "thread", id: "thread-0" },
    splitView: null,
    composerDrafts: {
      "thread:thread-0": { text: "Continue this thought", attachments: [], mentions: [], skills: [], threadReferences: [] },
      "project:project-1:main": { text: "Start a new thread", attachments: [], mentions: [], skills: [], threadReferences: [] },
      "free:main": { text: "A free-chat thought", attachments: [], mentions: [], skills: [], threadReferences: [] },
    },
    transcripts: { "thread-0": { ...emptyThreadState(), loaded: true, thread: threads["thread-0"]!, blocks: [{ kind: "user", id: "user", turnId: "turn", at, seq: 0, message: { parts: [{ type: "text", text: "Investigate the project" }] } }] } },
  })
  flushSync(() => createRoot(document.getElementById("root")!, { onUncaughtError: error => native().postMessage(JSON.stringify({ pass: false, error: String(error) })) }).render(
    <ThemeProviderContext value={{ theme: "dark", translucent: false, setTheme: () => {}, setTranslucent: () => {} }}>
      <SidebarProvider><Sidebar><ThreadSidebar /></Sidebar><main className="flex h-screen min-w-0 flex-1 flex-col"><ThreadView threadId="thread-0" /></main></SidebarProvider>
    </ThemeProviderContext>,
  ))
  await sleep(500)
  let sequence = 0
  const samples = []
  for (const baseline of (notificationsOnly ? [] : [true, false, true, false])) {
    const commits: number[] = [], frames: number[] = []
    let chrome = 0
    const unsubscribe = useStore.subscribe((next, previous) => { if (next.threads !== previous.threads) chrome++ })
    let previous = await frame()
    for (let i = 0; i < 100; i++) {
      const start = performance.now()
      flushSync(() => {
        useStore.getState().receiveEvent({ kind: "assistant_thinking_delta", seq: ++sequence, thread_id: "thread-0", turn_id: "turn", at, message_id: "thinking", origin, delta: "Inspecting another file. " })
        if (baseline) useStore.getState().set(state => ({ threads: { ...state.threads, "thread-0": state.transcripts["thread-0"]!.thread! } }))
      })
      commits.push(performance.now() - start)
      const now = await frame(); frames.push(now - previous); previous = now
    }
    unsubscribe()
    samples.push({ baseline, chrome, commitP95: p95(commits), frameP95: p95(frames) })
  }
  const state = useStore.getState()
  state.receiveEvent({ kind: "turn_completed", seq: ++sequence, thread_id: "thread-0", turn_id: "turn", at: new Date().toISOString(), stop_reason: "completed", usage: { input_tokens: 1200, output_tokens: 160, cache_read_tokens: 900, cache_write_tokens: 0 }, cost_usd: null, duration_ms: 2400, terminal_message_id: null })
  state.receiveEvent({ kind: "thread_updated", seq: ++sequence, thread_id: "thread-0", turn_id: null, at, thread: { ...state.threads["thread-0"]!, title: "Updated immediately", status: "idle" } })
  await sleep(100)
  flushSync(() => {
    useStore.getState().pushNotification("thread-20", "done", sequence + 1, at)
    useStore.getState().pushNotification("thread-21", "done", sequence + 2, at)
    useStore.getState().pushNotification("thread-999", "done", sequence + 3, at)
  })
  const sidebarUnread = !!document.querySelector('[aria-label="Unread"]')
  const draftIndicators = {
    thread: document.querySelectorAll('[data-composer-draft="thread"]').length === 1,
    newThread: document.querySelectorAll('[data-composer-draft="new-thread"]').length === 1,
  }
  const promptCache = document.querySelector('[data-prompt-cache="warm"]')?.textContent?.trim() === "30m"
  const freeChats = document.body.textContent?.includes("Recents") === true && document.body.textContent?.includes("Plan a weekend trip") === true && document.querySelectorAll('[data-composer-draft="free-chat"]').length === 1
  const bell = document.querySelector<HTMLButtonElement>('button[aria-label^="Show threads that need attention"]')!
  const dot = bell.querySelector<HTMLElement>('[data-slot="notification-dot"]')!
  const dotStyle = getComputedStyle(dot)
  const dotHasNoOutline = dotStyle.boxShadow === "none" && dotStyle.outlineStyle === "none"
  const openBellMenu = async () => {
    const rect = bell.getBoundingClientRect()
    bell.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: rect.right, clientY: rect.bottom }))
    await sleep(50)
  }
  await openBellMenu()
  const firstMenu = document.querySelector<HTMLElement>('[data-slot="context-menu-content"]')!
  const firstMenuText = firstMenu.textContent ?? ""
  const menuItems = Array.from(firstMenu.querySelectorAll<HTMLElement>('[data-slot="context-menu-item"]'))
  const dismissAll = menuItems.find(item => item.textContent?.includes("Dismiss all"))
  dismissAll?.click()
  await sleep(50)
  const allDismissed = selectAttentionItems(useStore.getState()).length === 0
  flushSync(() => useStore.getState().set(state => ({ threads: { ...state.threads, "thread-998": { ...state.threads["thread-998"]!, last_seq: 13 } } })))
  const newerFailureVisible = selectAttentionItems(useStore.getState()).some(item => item.thread.id === "thread-998" && item.kind === "failed")
  flushSync(() => {
    useStore.getState().pushNotification("thread-20", "done", sequence + 4, at)
    useStore.getState().pushNotification("thread-21", "done", sequence + 5, at)
  })
  await openBellMenu()
  const bellMenu = {
    dotHasNoOutline,
    boundedActions: menuItems.length === 2,
    hasFilterAction: firstMenuText.includes("Show notifications"),
    hasDismissAction: firstMenuText.includes("Dismiss all"),
    allDismissed,
    newerFailureVisible,
  }
  const pass = samples.every(sample => sample.chrome === (sample.baseline ? 100 : 0)) && state.transcript("thread-0").lastSeq === sequence && document.body.textContent?.includes("Updated immediately") === true
  const activityCommits: number[] = []
  for (let i = 0; i < (notificationsOnly ? 0 : 100); i++) {
    const start = performance.now()
    flushSync(() => useStore.getState().set(state => ({ threadActivity: { ...state.threadActivity, "thread-0": { thread_id: "thread-0", state: "working", active_agents: 1, active_processes: i + 1, active_monitors: 0 } } })))
    activityCommits.push(performance.now() - start)
    await frame()
  }
  flushSync(() => useStore.getState().set({
    collapsedProjects: { "project-0": true },
    threadActivity: { ...useStore.getState().threadActivity, "thread-0": { thread_id: "thread-0", state: "working", active_agents: 1, active_processes: 1, active_monitors: 0 } },
  }))
  const projectHeader = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-sidebar="menu-button"]')).find(button => button.textContent?.trim() === "Project 0")
  const working = !!projectHeader()?.querySelector('[aria-label="Working"]')
  flushSync(() => useStore.getState().set({ threadActivity: { "thread-0": { thread_id: "thread-0", state: "monitoring", active_agents: 0, active_processes: 0, active_monitors: 1 } } }))
  const monitoring = !!projectHeader()?.querySelector('[aria-label="Monitoring"]')
  flushSync(() => useStore.getState().set({ threadActivity: {} }))
  const idle = !!projectHeader() && !projectHeader()?.querySelector('[aria-label="Working"], [aria-label="Monitoring"]')
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  await sleep(50)
  flushSync(() => useStore.getState().set({ collapsedProjects: {} }))
  await sleep(100)
  native().postMessage(JSON.stringify({ notificationsOnly, threads: 1001, projects: 20, samples, sidebarUnread, draftIndicators, promptCache, freeChats, bellMenu, activityCommitP95: p95(activityCommits), projectActivityTransitions: { working, monitoring, idle }, pass: pass && sidebarUnread && Object.values(draftIndicators).every(Boolean) && promptCache && freeChats && Object.values(bellMenu).every(Boolean) && working && monitoring && idle }))
}
run().catch(error => native().postMessage(JSON.stringify({ pass: false, error: String(error) })))
