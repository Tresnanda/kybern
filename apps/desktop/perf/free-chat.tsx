import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"

import { Sidebar, SidebarProvider } from "../src/components/kit/sidebar"
import { ThemeProviderContext } from "../src/components/theme-context"
import { FREE_CHAT_PROJECT_ID, type Project, type ProviderStatus, type Thread } from "../src/protocol"
import { useStore } from "../src/state/store"
import { Draft } from "../src/views/Draft"
import { ThreadSidebar } from "../src/views/Sidebar"
import "../src/index.css"

const at = new Date().toISOString()
const project: Project = { id: "project", name: "Kybern", path: "/kybern", is_git: true, worktrees_default: false, created_at: at, updated_at: at }
const providers: ProviderStatus[] = [{ kind: "codex", display_name: "Codex", available: true, instances: ["default"], supported_permission_modes: ["supervised", "full-access"], supports_fork: true, supports_model_switch: true, supports_effort_switch: true, supported_efforts: ["medium", "high"], models: [{ id: "gpt-5.6-sol", display_name: "GPT-5.6 Sol", is_default: true, default_effort: "medium", efforts: ["medium", "high"] }] }]
const freeThreads: Thread[] = [
  { id: "free-1", project_id: FREE_CHAT_PROJECT_ID, title: "Plan a weekend trip", provider: { kind: "codex", instance: "default" }, model: "gpt-5.6-sol", effort: "medium", permission_mode: "supervised", status: "idle", cwd: "/free-chat", worktree: null, provider_session_id: "session-1", pinned: false, created_at: at, updated_at: at, last_seq: 4 },
  { id: "free-2", project_id: FREE_CHAT_PROJECT_ID, title: "Compare camera lenses", provider: { kind: "codex", instance: "default" }, model: "gpt-5.6-sol", effort: "medium", permission_mode: "supervised", status: "idle", cwd: "/free-chat", worktree: null, provider_session_id: "session-2", pinned: false, created_at: at, updated_at: new Date(Date.now() - 60_000).toISOString(), last_seq: 4 },
]

const native = () => (window as unknown as { webkit: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }).webkit.messageHandlers.bench

async function run() {
  document.documentElement.classList.add("dark")
  flushSync(() => useStore.getState().set({
    connection: { state: "open" },
    projects: { [project.id]: project },
    threads: Object.fromEntries(freeThreads.map((thread) => [thread.id, thread])),
    providers,
    providersLoading: false,
    selected: { kind: "draft", draft: {} },
    composerDrafts: { "free:main": { text: "Help me think through a fresh idea", attachments: [], mentions: [], skills: [], threadReferences: [] } },
  }))
  flushSync(() => createRoot(document.getElementById("root")!).render(
    <ThemeProviderContext value={{ theme: "dark", translucent: false, setTheme: () => {}, setTranslucent: () => {} }}>
      <SidebarProvider>
        <Sidebar><ThreadSidebar /></Sidebar>
        <main className="flex h-screen min-w-0 flex-1 flex-col"><Draft /></main>
      </SidebarProvider>
    </ThemeProviderContext>,
  ))
  await new Promise((resolve) => setTimeout(resolve, 500))
  const labels = [...document.querySelectorAll("span")]
  const projectsLabel = labels.find((element) => element.textContent === "Projects")
  const recentsLabel = labels.find((element) => element.textContent === "Recents")
  const firstFreeChatRow = labels
    .find((element) => element.textContent === freeThreads[0].title)
    ?.closest<HTMLElement>('[role="button"]')
  const recentsDisclosure = document.querySelector<HTMLButtonElement>("[data-recents-disclosure]")
  recentsDisclosure?.click()
  await new Promise((resolve) => setTimeout(resolve, 280))
  const recentsCollapsed = recentsDisclosure?.getAttribute("aria-expanded") === "false"
    && document.getElementById("sidebar-recents")?.closest("[aria-hidden=true]") !== null
  recentsDisclosure?.click()
  await new Promise((resolve) => setTimeout(resolve, 280))
  const checks = {
    heading: document.body.textContent?.includes("What can I help with?") === true,
    recents: freeThreads.every((thread) => document.body.textContent?.includes(thread.title)),
    freeChatChip: document.body.textContent?.includes("Free chat") === true,
    noProjectControls: !document.body.textContent?.includes("Checkout") && !document.body.textContent?.includes("New worktree"),
    draft: document.querySelectorAll('[data-composer-draft="free-chat"]').length === 1,
    recentsBelowProjects: !!projectsLabel && !!recentsLabel && Boolean(projectsLabel.compareDocumentPosition(recentsLabel) & Node.DOCUMENT_POSITION_FOLLOWING),
    freeChatsNotNested: firstFreeChatRow?.style.paddingInlineStart === "8px",
    recentsDisclosure: recentsCollapsed && recentsDisclosure?.getAttribute("aria-expanded") === "true",
  }
  native().postMessage(JSON.stringify({ ...checks, pass: Object.values(checks).every(Boolean) }))
}

run().catch((error) => native().postMessage(JSON.stringify({ pass: false, error: String(error), stack: error.stack })))
