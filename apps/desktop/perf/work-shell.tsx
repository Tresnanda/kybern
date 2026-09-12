// Compare sequence-only thread publication with the scoped store, using the
// actual sidebar, thread header, composer and transcript. No provider is called.
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { ThreadView } from "../src/views/Thread"
import { ThreadSidebar } from "../src/views/Sidebar"
import { Sidebar, SidebarProvider } from "../src/components/kit/sidebar"
import { ThemeProviderContext } from "../src/components/theme-context"
import { useStore } from "../src/state/store"
import { emptyThreadState } from "../src/state/transcript"
import type { Thread, Project } from "../src/protocol"
import "../src/index.css"
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const frame = () => new Promise<number>(resolve => requestAnimationFrame(resolve))
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * .95)] ?? 0
const at = "2026-09-01T12:00:00Z"
const origin = { kind: "root" } as const
const projects: Record<string, Project> = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`project-${i}`, { id: `project-${i}`, name: `Project ${i}`, path: "/project", is_git: false, worktrees_default: false, created_at: at, updated_at: at }]))
const threads: Record<string, Thread> = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`thread-${i}`, { id: `thread-${i}`, project_id: `project-${i % 20}`, title: `Thread ${i}`, provider: { kind: "omp", instance: "default" }, model: null, effort: null, permission_mode: "full-access", status: i === 0 ? "running" : "idle", cwd: "/project", worktree: null, provider_session_id: null, pinned: false, created_at: at, updated_at: at, last_seq: 0 }]))
const native = () => (window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }).webkit.messageHandlers.bench
async function run() {
  document.documentElement.classList.add("dark")
  useStore.getState().set({ projects, threads, providers: [], selected: { kind: "thread", id: "thread-0" }, splitView: null, transcripts: { "thread-0": { ...emptyThreadState(), loaded: true, thread: threads["thread-0"]!, blocks: [{ kind: "user", id: "user", turnId: "turn", at, seq: 0, message: { parts: [{ type: "text", text: "Investigate the project" }] } }] } } })
  flushSync(() => createRoot(document.getElementById("root")!, { onUncaughtError: error => native().postMessage(JSON.stringify({ pass: false, error: String(error) })) }).render(
    <ThemeProviderContext value={{ theme: "dark", translucent: false, setTheme: () => {}, setTranslucent: () => {} }}>
      <SidebarProvider><Sidebar><ThreadSidebar /></Sidebar><main className="flex h-screen min-w-0 flex-1 flex-col"><ThreadView threadId="thread-0" /></main></SidebarProvider>
    </ThemeProviderContext>,
  ))
  await sleep(500)
  let sequence = 0
  const samples = []
  for (const baseline of [true, false, true, false]) {
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
  state.receiveEvent({ kind: "thread_updated", seq: ++sequence, thread_id: "thread-0", turn_id: null, at, thread: { ...state.threads["thread-0"]!, title: "Updated immediately", status: "idle" } })
  await sleep(100)
  const pass = samples.every(sample => sample.chrome === (sample.baseline ? 100 : 0)) && state.transcript("thread-0").lastSeq === sequence && document.body.textContent?.includes("Updated immediately") === true
  const activityCommits: number[] = []
  for (let i = 0; i < 100; i++) {
    const start = performance.now()
    flushSync(() => useStore.getState().set(state => ({ threadActivity: { ...state.threadActivity, "thread-0": { thread_id: "thread-0", state: "working", active_agents: 1, active_processes: i + 1, active_monitors: 0 } } })))
    activityCommits.push(performance.now() - start)
    await frame()
  }
  flushSync(() => useStore.getState().set({ collapsedProjects: { "project-0": true } }))
  const projectHeader = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-sidebar="menu-button"]')).find(button => button.textContent?.trim() === "Project 0")
  const working = !!projectHeader()?.querySelector('[aria-label="Working"]')
  flushSync(() => useStore.getState().set({ threadActivity: { "thread-0": { thread_id: "thread-0", state: "monitoring", active_agents: 0, active_processes: 0, active_monitors: 1 } } }))
  const monitoring = !!projectHeader()?.querySelector('[aria-label="Monitoring"]')
  flushSync(() => useStore.getState().set({ threadActivity: {} }))
  const idle = !!projectHeader() && !projectHeader()?.querySelector('[aria-label="Working"], [aria-label="Monitoring"]')
  native().postMessage(JSON.stringify({ threads: 1000, projects: 20, samples, activityCommitP95: p95(activityCommits), projectActivityTransitions: { working, monitoring, idle }, pass: pass && working && monitoring && idle }))
}
run().catch(error => native().postMessage(JSON.stringify({ pass: false, error: String(error) })))
