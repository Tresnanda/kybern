/* eslint-disable react-refresh/only-export-components */
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { ThreadView } from "../src/views/Thread"
import { Draft } from "../src/views/Draft"
import { RightPanel } from "../src/views/RightPanel"
import { composerEditorValue } from "../src/components/kit/chat/ComposerEditor"
import { ThreadSidebar } from "../src/views/Sidebar"
import { Sidebar, SidebarProvider } from "../src/components/kit/sidebar"
import { ThemeProviderContext } from "../src/components/theme-context"
import { buildThemeCssVariables, DEFAULT_THEME_STATE } from "../src/lib/kit/theme/theme.logic"
import { useStore } from "../src/state/store"
import { useEnvironments } from "../src/state/environments"
import { emptyThreadState } from "../src/state/transcript"
import { chatFixture, fixtureConnection } from "./chat-coordinator-rpc"
import { attachEnvFeed } from "../src/state/notes"
import { CoordinatorDefaultsSection, useSettings } from "../src/views/SettingsScreen"
import { RailUsage } from "../src/views/RailUsage"
import { Toaster } from "../src/components/ui/sonner"
import { toast } from "sonner"
import { useUsageLimits } from "../src/state/usageLimits"
import type { ApprovalRequest, Note, Thread, Project, ProviderStatus, Settings } from "../src/protocol"
import "../src/index.css"

const query = new URLSearchParams(location.search)
declare const __FIXTURE_THEME__: "dark" | "light"
declare const __FIXTURE_VIEW__: string
const theme = (query.get("theme") ?? __FIXTURE_THEME__) === "light" ? "light" : "dark"
const preview = query.get("view") ?? __FIXTURE_VIEW__
const at = "2026-09-14T10:00:00Z"
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const results = (value: unknown) => {
  const target = window as unknown as { __chatCoordinatorResults?: unknown[]; webkit?: { messageHandlers?: { bench?: { postMessage: (value: string) => void } } } }
  ;(target.__chatCoordinatorResults ??= []).push(value)
  // A browser without the native bench handler reads the outcome from the page.
  document.documentElement.dataset.fixtureResults = JSON.stringify(target.__chatCoordinatorResults)
  target.webkit?.messageHandlers?.bench?.postMessage(JSON.stringify(value))
}
const sampleMemory = (stage: string) => new Promise<void>((resolve) => {
  const target = window as unknown as { __memoryContinue?: () => void; webkit?: { messageHandlers?: { bench?: { postMessage: (value: string) => void } } } }
  target.__memoryContinue = resolve
  target.webkit?.messageHandlers?.bench?.postMessage(JSON.stringify({ stage, memory: true }))
})
const projects: Record<string, Project> = Object.fromEntries(["Kybern", "Website"].map((name, index) => [`project-${index}`, { id: `project-${index}`, name, path: "/project", is_git: true, brief_in_all_threads: false, created_at: at, updated_at: at }]))
/** Ask the native runner for a named screenshot (KYBERN_PERF_SHOTS_DIR); it resumes the page once written. */
const shot = (name: string) => new Promise<void>((resolve) => {
  for (const animation of document.getAnimations()) {
    try { if (animation.effect?.getComputedTiming().iterations !== Infinity) animation.finish() } catch { /* not finishable */ }
  }
  const target = window as unknown as { __screenshotContinue?: () => void; webkit?: { messageHandlers?: { bench?: { postMessage: (value: string) => void } } } }
  target.__screenshotContinue = resolve
  if (!target.webkit?.messageHandlers?.bench) return resolve()
  target.webkit.messageHandlers.bench.postMessage(JSON.stringify({ screenshot: `${name}-${theme}` }))
})
const projectNote = (id: string, title: string, body: string, updated: string, extra: Partial<Note> = {}): Note => ({ id, scope: "project", project_id: "project-0", title, body, preview: body.replace(/[#*`]/g, "").slice(0, 240), checklist: { done: 0, total: 0 }, pinned: false, revision: 1, created_at: updated, updated_at: updated, ...extra })
const seededNotes = [
  projectNote("brief", "Project brief", "Kybern: desktop, daemon and mobile client for coding agents. Ship small PRs against main, one task each.\n\nPropose threads for anything that touches the protocol before starting them. Use the iPad 27 device for mobile checks.", "2026-09-14T08:00:00Z", { project_role: "brief", pinned: true }),
  projectNote("setup", "How to build, run and test", "cargo build -p kybern, a scratch daemon on 4199, then pnpm tauri dev with KYBERN_DATA_DIR.", "2026-09-14T08:00:00Z", { project_role: "setup", pinned: true, created_by_thread: "main" }),
  projectNote("memory-1", "Native WebKit fixtures need the production CSP", "Run check-rendering so iframes load under the shipped policy.", "2026-09-14T09:00:00Z", { created_by_thread: "worker" }),
  projectNote("memory-2", "Prefers squash merges and small PRs", "One task per PR; bump the version inside the PR.", "2026-09-14T07:00:00Z", { created_by_thread: "main" }),
  projectNote("memory-3", "Mobile export takes about four minutes", "Run both platform exports only at the end.", "2026-09-13T10:00:00Z"),
]
const thread = (id: string, title: string, extra: Partial<Thread> = {}): Thread => ({ id, title, project_id: "project-0", provider: { kind: "claude-code", instance: "default" }, permission_mode: "supervised", status: "idle", cwd: "/project", pinned: false, created_at: at, updated_at: at, last_seq: 0, ...extra })
const threads: Record<string, Thread> = {
  main: thread("main", "Improve sign-in"),
  worker: thread("worker", "Implement sign-in", { parent_thread_id: "main", status: "running", provider: { kind: "codex", instance: "default" } }),
  reviewer: thread("reviewer", "Review sign-in", { parent_thread_id: "main", status: "running" }),
  previous: thread("previous", "Authentication decisions"),
  other: thread("other", "Authentication decisions", { project_id: "project-1", provider: { kind: "codex", instance: "default" } }),
}
const providers: ProviderStatus[] = [
  { kind: "claude-code", display_name: "Claude Code", available: true, supported_permission_modes: ["supervised", "full-access"], supports_fork: true, supports_model_switch: true, instances: ["default"], models: [{ id: "default", display_name: "Default model", is_default: true }, { id: "claude-opus-5-5", display_name: "Opus 5.5", efforts: ["medium", "high"] }, { id: "claude-sonnet-5-5", display_name: "Sonnet 5.5" }] },
  { kind: "codex", display_name: "Codex", available: true, supported_permission_modes: ["supervised", "full-access"], supports_fork: true, supports_model_switch: true, instances: ["default"], models: [{ id: "gpt-5.6-sol", display_name: "GPT-5.6 Sol", is_default: true }] },
  { kind: "cursor", display_name: "Cursor", available: true, supported_permission_modes: ["supervised", "full-access"], supports_fork: true, supports_model_switch: true, instances: ["default"], models: [{ id: "auto", display_name: "Auto", is_default: true }] },
  { kind: "opencode", display_name: "OpenCode", available: true, supported_permission_modes: ["supervised", "full-access"], supports_fork: true, supports_model_switch: true, instances: ["default"], models: [{ id: "default", display_name: "Default model", is_default: true }] },
  { kind: "pi", display_name: "Pi", available: true, supported_permission_modes: ["supervised", "full-access"], supports_fork: true, supports_model_switch: true, instances: ["default"], models: [{ id: "default", display_name: "Default model", is_default: true }] },
  { kind: "omp", display_name: "Oh My Pi", available: true, supported_permission_modes: ["supervised", "full-access"], supports_fork: true, supports_model_switch: true, instances: ["default"], models: [{ id: "default", display_name: "Default model", is_default: true }] },
]
const visible = (element: HTMLElement) => element.getClientRects().length > 0 && !element.closest('[aria-hidden="true"], [inert]')
function findButton(label: string) { return Array.from(document.querySelectorAll<HTMLElement>('button,[role="button"],[role="menuitem"],[role="menuitemradio"]')).find((element) => visible(element) && (element.getAttribute("aria-label") === label || element.title === label || element.textContent?.trim() === label)) }
async function click(label: string) { const element = findButton(label); if (!element) throw new Error(`Missing button ${label}`); element.click(); await sleep(220) }
function write(value: string) {
  const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]')!
  editor.focus()
  getSelection()!.selectAllChildren(editor)
  document.execCommand("insertText", false, value)
  editor.dispatchEvent(new KeyboardEvent("keyup", { key: value.slice(-1), bubbles: true }))
  return editor
}
function Shell() {
  const selected = useStore((state) => state.selected)
  const rightOpen = useStore((state) => state.rightOpen)
  const id = selected.kind === "thread" ? selected.id : null
  return <ThemeProviderContext value={{ theme, translucent: false, setTheme: () => {}, setTranslucent: () => {} }}><Toaster /><SidebarProvider><Sidebar><ThreadSidebar /></Sidebar><main className="flex h-screen min-w-0 flex-1 flex-col">{selected.kind === "draft" ? <Draft key={`${selected.draft.projectId}:${selected.draft.purpose}`} projectId={selected.draft.projectId} purpose={selected.draft.purpose} /> : <ThreadView key={id ?? "main"} threadId={id ?? "main"} />}</main>{rightOpen && <aside className="h-screen w-[440px] border-s border-[color:var(--app-surface-divider)]"><RightPanel threadId={id} /></aside>}</SidebarProvider></ThemeProviderContext>
}
async function run() {
  const root = document.documentElement
  root.classList.toggle("dark", theme === "dark"); root.dataset.themeVariant = theme; root.dataset.runtime = "electron"; root.dataset.platform = "macos"
  const built = buildThemeCssVariables({ codeThemeId: DEFAULT_THEME_STATE.codeThemeIds[theme], theme: DEFAULT_THEME_STATE.chromeThemes[theme] }, theme, { electron: true, isMac: true, systemUiFont: true })
  for (const [key, value] of Object.entries(built.variables)) root.style.setProperty(key, value)
  useEnvironments.setState({ selectedId: "local", switching: false, profiles: [{ id: "local", name: "UI preview", url: null, environment_id: "fixture", hostname: "Local", local: true }] })
  const transcripts = Object.fromEntries(Object.values(threads).map((item) => [item.id, { ...emptyThreadState(), loaded: true, thread: item }]))
  transcripts.main.blocks = [
    { kind: "user", id: "user-1", turnId: "turn-1", at, seq: 1, message: { parts: [{ type: "text", text: "Improve sign-in. Have Codex implement it and Claude review it. Use our earlier authentication decisions." }] } },
    { kind: "assistant", id: "assistant-1", messageId: "assistant-1", segment: 0, thinking: "", turnId: "turn-1", at, seq: 2, text: "I’ve started two helper threads. Codex is implementing the sign-in changes, and Claude is reviewing the existing flow.\n\nI’ll bring their findings back here. You can open either thread below to follow along or give it more direction.", origin: { kind: "root" }, complete: true },
    { kind: "turn_end", id: "end-1", turnId: "turn-1", at, seq: 3, stopReason: "completed", usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, costUsd: null, durationMs: 4000, terminalMessageId: "assistant-1", error: null },
  ]
  useStore.getState().set({ projects, threads, providers, selected: { kind: "thread", id: "main" }, splitView: null, transcripts, composerDrafts: {}, connection: { state: "open" }, rightOpen: false, rightTabs: [], rightTab: null, envOpen: false })
  for (const note of seededNotes) chatFixture.notes.set(note.id, note)
  attachEnvFeed(fixtureConnection as never, "fixture")
  flushSync(() => createRoot(document.getElementById("root")!, { onUncaughtError: (error) => results({ pass: false, error: String(error), stack: String((error as Error)?.stack ?? "") }) }).render(<Shell />))
  await sleep(650)
  if (preview === "composer-caret-before") {
    const baseline = document.createElement("style")
    baseline.textContent = '[data-composer-editor-frame]{min-height:0!important}[data-testid="composer-editor"],[data-composer-editor-frame]{line-height:1.625!important}[data-testid="composer-editor"]{min-height:var(--app-density-composer-editor-min-height,2lh)!important}'
    document.head.append(baseline)
  }
  if (preview === "composer-caret-before" || preview === "composer-caret-after") {
    const editor = write("subthreads")
    const frame = editor.closest<HTMLElement>('[data-composer-editor-frame]')!
    await sleep(100)
    const lineHeight = parseFloat(getComputedStyle(editor).lineHeight)
    return results({ preview, pass: true, editorHeight: editor.getBoundingClientRect().height, frameHeight: frame.getBoundingClientRect().height, lineHeight })
  }
  if (preview === "dock-memory") {
    useStore.getState().set({ rightOpen: true, rightTabs: ["agents"], rightTab: "agents" })
    await sleep(500)
    await sampleMemory("dock-one-panel")
    useStore.getState().set({ rightTabs: ["agents", "activity", "changes", "terminal", "artifacts", "explorer"], rightTab: "agents" })
    await sleep(500)
    await sampleMemory("dock-six-panels")
    return results({ preview, pass: document.querySelectorAll(".t-pane").length === 6 && document.querySelectorAll('.t-pane[data-active="false"]').length === 5 })
  }
  const initialHasNoSetup = !document.body.textContent?.includes("Let agent start helpers") && !!document.querySelector('[data-testid="composer-editor"]')
  const initialEditor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]')!
  const initialEditorFrame = initialEditor.closest<HTMLElement>('[data-composer-editor-frame]')!
  const editorLineHeight = parseFloat(getComputedStyle(initialEditor).lineHeight)
  const composerSingleLineEditorInTwoLineFrame = initialEditor.clientHeight <= editorLineHeight + 1 && initialEditorFrame.clientHeight >= editorLineHeight * 1.9
  initialEditor.blur()
  initialEditorFrame.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
  const blankComposerAreaFocusesEditor = document.activeElement === initialEditor
  const helperToggle = findButton("Expand 2 helpers for Improve sign-in")
  const helperRows = () => Array.from(document.querySelectorAll<HTMLElement>("[data-marquee-host]")).filter(row => row.textContent?.includes("Implement sign-in") || row.textContent?.includes("Review sign-in"))
  let sidebarDisclosure = true
  if (helperToggle) {
    sidebarDisclosure = helperRows().length === 0
    helperToggle.click(); await sleep(300)
    sidebarDisclosure &&= helperRows().length === 2 && helperToggle.getAttribute("aria-expanded") === "true"
    if (preview === "hierarchy") {
      const parent = Array.from(document.querySelectorAll<HTMLElement>("[data-marquee-host]")).find(row => row.textContent === "Improve sign-in")!
      const children = helperRows()
      const indented = children.every(row => parseFloat(getComputedStyle(row).paddingInlineStart) - parseFloat(getComputedStyle(parent).paddingInlineStart) === 20)
      const guides = children.every(row => !!row.parentElement?.querySelector('span[aria-hidden="true"].w-px'))
      return results({ preview, pass: sidebarDisclosure && indented && guides, indented, guides })
    }
    helperToggle.click(); await sleep(300)
    sidebarDisclosure &&= helperRows().length === 0 && helperToggle.getAttribute("aria-expanded") === "false"
  }
  const messageId = "01a0a0e6-85d2-7c01-adfc-8ce6a93c5b0e"
  const agentMessage = { parts: [{ type: "thread_message" as const, message_id: messageId, from_thread_id: "reviewer", from_title: "Review sign-in", purpose: "reply" as const, reply_to: null, body: "Reviewed sign-in. All checks passed." }] }
  useStore.getState().set({ queued: { main: [{ id: messageId, message: agentMessage }] } }); await sleep(150)
  const queueToggle = findButton("1 agent update waiting")
  const updatesInitiallyCollapsed = !!queueToggle && !document.querySelector('[data-testid="queued-follow-up-row"]')
  queueToggle?.click(); await sleep(150)
  const updateRow = document.querySelector('[data-testid="queued-follow-up-row"]')
  const updatesReadable = updateRow?.textContent?.includes("Reply from Review sign-in") && !updateRow?.textContent?.includes(messageId)
  const originalTranscript = useStore.getState().transcripts.main
  useStore.getState().set({ transcripts: { ...useStore.getState().transcripts, main: { ...originalTranscript, blocks: [
    ...originalTranscript.blocks,
    { kind: "user", id: "agent-update", turnId: "update-turn", at, seq: 4, message: agentMessage },
    { kind: "turn_end", id: "update-end", turnId: "update-turn", at, seq: 5, stopReason: "completed", usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, costUsd: null, durationMs: 0, terminalMessageId: null, error: null },
  ] } } }); await sleep(300)
  const inbound = document.querySelector('[data-inbound-message="reply"]')
  const messageReadable = !!inbound && !!inbound.textContent?.includes("Reviewed sign-in. All checks passed.") && !inbound.textContent?.includes(messageId)
  if (preview === "disclosure") return results({ preview, pass: sidebarDisclosure && updatesInitiallyCollapsed && updatesReadable && messageReadable })
  useStore.getState().set({ queued: {}, transcripts: { ...useStore.getState().transcripts, main: originalTranscript } }); await sleep(100)
  if (preview === "chat") return results({ preview, pass: initialHasNoSetup && sidebarDisclosure && updatesInitiallyCollapsed && updatesReadable })
  useStore.getState().set({ rightOpen: true }); await sleep(220)
  const dock = () => document.querySelector("aside:has([aria-label='Add panel'])")!
  const emptyDock = dock().textContent?.includes("Add a panel with +.") && dock().querySelectorAll(".t-pane").length === 0 && dock().querySelectorAll("[data-tab-active]").length === 0
  if (preview === "empty-dock") return results({ preview, pass: emptyDock })
  const addPanel = async (label: string) => {
    await click("Add panel")
    const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((element) => visible(element) && element.textContent?.startsWith(label))
    if (!item) throw new Error(`Missing panel menu item ${label}`)
    item.click(); await sleep(250)
  }
  await addPanel("Agents")
  const firstPanel = dock().querySelectorAll(".t-pane").length === 1 && !!findButton("Close Agents panel")
  await addPanel("Diff")
  if (preview === "dock-panels") return results({ preview, pass: firstPanel && dock().querySelectorAll(".t-pane").length === 2 })
  await addPanel("Agents")
  const noDuplicatePanels = dock().querySelectorAll("[data-tab-active]").length === 2 && useStore.getState().rightTab === "agents"
  await click("Collapse panel")
  useStore.getState().set({ rightOpen: true }); await sleep(220)
  const dockReopensChoices = dock().querySelectorAll("[data-tab-active]").length === 2 && useStore.getState().rightTab === "agents"
  await click("Close Agents panel")
  const closeSelectsNeighbor = useStore.getState().rightTab === "changes" && dock().querySelectorAll(".t-pane").length === 1
  await click("Close Diff panel")
  const closeLastEmptiesDock = dock().textContent?.includes("Add a panel with +.") && dock().querySelectorAll(".t-pane").length === 0 && document.activeElement?.getAttribute("aria-label") === "Add panel"
  await addPanel("Terminal")
  const activePill = getComputedStyle(dock().querySelector(".t-tabs-pill")!)
  const terminalTab = getComputedStyle(dock().querySelector("[data-tab-active='true']")!)
  const terminalShapeMatches = parseFloat(activePill.borderTopLeftRadius) > 0 && activePill.borderRadius === terminalTab.borderRadius && activePill.getPropertyValue("corner-shape") === terminalTab.getPropertyValue("corner-shape")
  if (preview === "terminal-shape") return results({ preview, pass: terminalShapeMatches, radius: activePill.borderRadius, corner: activePill.getPropertyValue("corner-shape") })
  await click("Close Terminal panel")
  const dockChecks = { messageReadable, sidebarDisclosure, updatesInitiallyCollapsed, updatesReadable, emptyDock, firstPanel, noDuplicatePanels, dockReopensChoices, closeSelectsNeighbor, closeLastEmptiesDock, terminalShapeMatches }
  await click("Collapse panel")
  await click(findButton("Implement sign-in") ? "Implement sign-in" : "Implement sign-inWorking")
  const back = findButton("Main thread") ?? findButton("Back to Improve sign-in")
  if (!back) throw new Error("Child thread has no return path")
  if (preview === "child") return results({ preview, pass: true })
  back.click(); await sleep(220)
  const childReturn = useStore.getState().selected.kind === "thread" && (useStore.getState().selected as { id: string }).id === "main"
  write("Read @Authentication"); await sleep(350)
  const options = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).filter((element) => visible(element) && element.textContent?.includes("Authentication decisions"))
  if (options.length < 2) throw new Error("Existing-thread picker did not expose both matching threads")
  if (preview === "references") return results({ preview, pass: true })
  options[0].click(); await sleep(150)
  const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]')!
  const editorText = composerEditorValue(editor)
  const titleOnlyReference = editorText.includes("Authentication decisions") && !editorText.includes("@thread[")
  const referenceDidNotWake = chatFixture.sent.length === 0 && !chatFixture.calls.some((call) => call.method === "threads.send")
  editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await sleep(200)
  const typedReferenceSent = chatFixture.sent[0]?.message.parts.some((part) => part.type === "thread_reference" && part.thread_id === "previous")
  if (!findButton("Create coordinator") && !preview.startsWith("coordinator-")) {
    const horizontalOverflow = Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
    const checks = { ...dockChecks, initialHasNoSetup, childReturn, titleOnlyReference, referenceDidNotWake, typedReferenceSent, noHorizontalOverflow: horizontalOverflow <= 1 }
    return results({ fixture: "chat-coordinator", pass: Object.values(checks).every(Boolean), checks, horizontalOverflow, coordinatorTest: "Covered in the wide sidebar fixture" })
  }
  if (findButton("Create coordinator")) await click("Create coordinator")
  else useStore.getState().selectDraft("project-0", "coordinator")
  await sleep(850)
  const coordinatorDraftInert = document.body.textContent?.includes("What should we work on in") && document.body.textContent?.includes("Tell the Coordinator about this project. It asks a few questions to set itself up.") && chatFixture.coordinatorCreates === 0 && chatFixture.sent.length === 1
  const settledSidebarRowsCrisp = Array.from(document.querySelectorAll<HTMLElement>("[data-marquee-host]")).every((row) => getComputedStyle(row).filter === "none")
  if (preview === "coordinator-draft") return results({ preview, pass: coordinatorDraftInert && settledSidebarRowsCrisp, settledSidebarRowsCrisp })
  await click("Change model and reasoning"); await sleep(120)
  const allHarnessesVisible = ["Claude Code", "Codex", "Cursor", "OpenCode", "Pi", "Oh My Pi"].every((label) => !!findButton(label))
  if (preview === "coordinator-harness") return results({ preview, pass: allHarnessesVisible })
  await click("Codex"); await sleep(120)
  const editsNotBlockedTooltip = !!document.querySelector('[title*="can\'t block file edits"]')
  write("Plan and ship the local coordinator experience.")
  await sleep(150); await click("Send message"); await sleep(350)
  const coordinator = useStore.getState().threads["project-coordinator"]
  const coordinatorOpensChat = (useStore.getState().selected as { id: string }).id === coordinator?.id && !!document.querySelector('[data-testid="composer-editor"]')
  const editsNotBlockedPill = !!Array.from(document.querySelectorAll<HTMLElement>('main span, [data-slot="badge"]')).find((element) => element.textContent?.trim() === "Edits not blocked on Codex")
  // The first message opens the setup with it; the daemon sends it, so the client sends nothing more.
  const openingMessageSent = chatFixture.calls.some((call) => call.method === "coordinator.open" && call.params.opening_message === "Plan and ship the local coordinator experience." && !("initial_brief" in call.params))
  const noSecondSend = !chatFixture.calls.some((call) => call.method === "threads.send" && call.params.thread_id === coordinator?.id)
  await click("Change model and reasoning"); await sleep(100); await click("Claude Code"); await sleep(250)
  const harnessSwitched = useStore.getState().threads["project-coordinator"]?.provider.kind === "claude-code" && chatFixture.calls.some((call) => call.method === "coordinator.switch_harness")
  const editsPillGoneOnClaude = !Array.from(document.querySelectorAll<HTMLElement>('main span, [data-slot="badge"]')).some((element) => element.textContent?.includes("Edits not blocked"))
  const oneCoordinatorCreated = chatFixture.coordinatorCreates === 1
  const projectTabOnlyForCoordinator = await (async () => {
    useStore.getState().set({ rightOpen: true, rightTabs: ["agents", "project"], rightTab: "project" }); await sleep(300)
    const coordinatorHasProject = !!document.querySelector("[data-project-panel]")
    useStore.getState().selectThread("main"); await sleep(300)
    const ordinaryHasNone = !document.querySelector("[data-project-panel]") && useStore.getState().rightTab === "project"
    useStore.getState().selectThread(coordinator.id); await sleep(200)
    return coordinatorHasProject && ordinaryHasNone
  })()
  const projectSpace = await checkProjectSpace()
  const secretRequest = await checkSecretRequest(coordinator.id)
  const coordinatorSetup = await checkCoordinatorSetup(coordinator.id)
  const horizontalOverflow = Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
  const checks = { ...projectSpace, ...secretRequest, ...coordinatorSetup, ...dockChecks, initialHasNoSetup, composerSingleLineEditorInTwoLineFrame, blankComposerAreaFocusesEditor, childReturn, titleOnlyReference, referenceDidNotWake, typedReferenceSent, coordinatorDraftInert, settledSidebarRowsCrisp, allHarnessesVisible, editsNotBlockedTooltip, coordinatorOpensChat, editsNotBlockedPill, openingMessageSent, noSecondSend, harnessSwitched, editsPillGoneOnClaude, oneCoordinatorCreated, projectTabOnlyForCoordinator, noHorizontalOverflow: horizontalOverflow <= 1 }
  results({ fixture: "chat-coordinator", pass: Object.values(checks).every(Boolean), checks, horizontalOverflow })
}
/** The Coordinator's Project tab: brief, setup, memory, the switch, editing and the empty project. */
async function checkProjectSpace() {
  useStore.getState().set({ rightOpen: true, rightTabs: ["agents", "project"], rightTab: "project" }); await sleep(400)
  const panel = () => document.querySelector<HTMLElement>("[data-project-panel]")!
  const text = () => panel().textContent ?? ""
  const memoryTitles = Array.from(panel().querySelectorAll<HTMLElement>('section[aria-label="Memory"] button')).map((row) => row.title)
  const projectSections = text().includes("Propose threads for anything") && text().includes("Only you can change the brief. Agents suggest edits in chat.") && text().includes("How to build, run and test")
    && memoryTitles.join("|") === "Native WebKit fixtures need the production CSP|Prefers squash merges and small PRs|Mobile export takes about four minutes"
    && panel().querySelector('section[aria-label="Memory"] h3 + span')?.textContent === "3"
  await shot("project-tab")
  // The brief switch is the panel's last; the Coordinator section has its own above it.
  Array.from(panel().querySelectorAll<HTMLElement>('[role="switch"]')).at(-1)!.click(); await sleep(200)
  const projectSwitch = chatFixture.calls.some((call) => call.method === "projects.update" && call.params.brief_in_all_threads === true) && useStore.getState().projects["project-0"]?.brief_in_all_threads === true
  await click("Edit the brief"); await sleep(900)
  const briefEditor = panel().querySelector<HTMLElement>('[contenteditable="true"]')
  const briefEditsInPlace = !!briefEditor && document.activeElement === briefEditor
  await shot("project-brief-editing")
  briefEditor?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await sleep(250)
  const briefEscapeCloses = !panel().querySelector('[contenteditable="true"]')
  // A project with no brief, setup or memory yet.
  for (const id of [...chatFixture.notes.keys()]) chatFixture.notes.delete(id)
  attachEnvFeed(fixtureConnection as never, "fixture-empty"); await sleep(300)
  const projectEmpty = text().includes("The Coordinator writes this on its first research pass") && text().includes("Agents save what they learn here") && !!findButton("Write the brief")
  await shot("project-empty")
  await click("Write the brief"); await sleep(900)
  const emptyEditor = panel().querySelector<HTMLElement>('[contenteditable="true"]')!
  emptyEditor.focus()
  document.execCommand("insertText", false, "Ship the iPad layout first.")
  await sleep(900)
  const briefCreated = chatFixture.calls.some((call) => call.method === "notes.create" && call.params.project_role === "brief" && String(call.params.body).includes("Ship the iPad layout first."))
  emptyEditor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await sleep(300)
  const briefShownAfterCreate = text().includes("Ship the iPad layout first.")
  useStore.getState().set({ rightOpen: false }); await sleep(200)
  return { projectSections, projectSwitch, briefEditsInPlace, briefEscapeCloses, projectEmpty, briefCreated, briefShownAfterCreate }
}

/** The secret card: masked field, no digit shortcuts, Enter saves, Decline, and the settled lines. */
async function checkSecretRequest(threadId: string) {
  const turnId = "secret-turn"
  const request = (id: string, input: Record<string, unknown>): ApprovalRequest => ({ id, thread_id: threadId, turn_id: turnId, tool_call_id: null, tool_name: "kybern_request_secret", input: input as never, summary: `Provide ${input.label}`, suggestions: [], created_at: at })
  const fresh = request("secret-1", { label: "Stripe test secret key", reason: "Needed to run the checkout tests against Stripe’s test mode. Find it under Developers → API keys.", env_key: "STRIPE_SECRET_KEY", file: ".env", replaces: false, placeholder: null })
  const replacing = request("secret-2", { label: "OpenAI API key", reason: "The embeddings script needs a key with access to text-embedding-3.", env_key: "OPENAI_API_KEY", file: "apps/api/.env.local", replaces: true, placeholder: "sk-…" })
  const show = (approval: ApprovalRequest) => {
    const state = useStore.getState()
    const current = state.transcript(threadId)
    const user = { kind: "user" as const, id: "secret-user", turnId, at, seq: 200, message: { parts: [{ type: "text" as const, text: "Run the checkout tests." }] } }
    const blocks = current.blocks.some((block) => block.id === user.id) ? current.blocks : [...current.blocks, user]
    state.set({ transcripts: { ...state.transcripts, [threadId]: { ...current, loaded: true, thread: state.threads[threadId], pendingApprovals: [approval], blocks: [...blocks, { kind: "approval", id: `approval:${approval.id}`, turnId, at, seq: 201 + blocks.length, approval, decision: null }] } } })
  }
  show(fresh); await sleep(400)
  const field = () => document.querySelector<HTMLInputElement>("[data-secret-request] input")
  const input = field()!
  const secretFieldFocused = document.activeElement === input
  const secretFieldHardened = input.type === "text" && input.autocomplete === "off" && input.getAttribute("autocorrect") === "off" && input.spellcheck === false
    && input.hasAttribute("data-1p-ignore") && input.getAttribute("data-lpignore") === "true" && input.hasAttribute("data-bwignore")
    && getComputedStyle(input).getPropertyValue("-webkit-text-security") === "disc"
  const card = () => document.querySelector("[data-secret-request]")?.textContent ?? ""
  const secretCopy = card().includes("Saves to .env as STRIPE_SECRET_KEY") && card().includes("Kybern writes it to the file. The agent never sees it.")
  input.focus()
  document.execCommand("insertText", false, "sk_test_1234")
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "3", bubbles: true }))
  input.blur()
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "3", bubbles: true })); await sleep(120)
  const digitsIgnored = !chatFixture.calls.some((call) => call.method === "approvals.respond") && field()?.value === "sk_test_1234"
  input.focus()
  await shot("secret-new")
  await click("Show the value")
  const secretRevealed = getComputedStyle(field()!).getPropertyValue("-webkit-text-security") === "none" && document.activeElement === field()
  await click("Hide the value")
  field()!.form!.requestSubmit(); await sleep(250)
  const saved = chatFixture.calls.find((call) => call.method === "approvals.respond" && call.params.approval_id === "secret-1")
  const secretSubmitted = saved?.params.decision === "submit" && saved.params.response?.secret === "sk_test_1234" && !document.querySelector("[data-secret-request]")
  show(replacing); await sleep(400)
  const secretReplaceCopy = card().includes("Replaces the current value of OPENAI_API_KEY in apps/api/.env.local") && field()?.placeholder === "sk-…"
  await shot("secret-replace")
  await click("Decline")
  const secretDeclined = chatFixture.calls.some((call) => call.method === "approvals.respond" && call.params.approval_id === "secret-2" && call.params.decision === "deny")
  // A third request that ended with the turn, as the daemon closes it.
  const ended = request("secret-3", { label: "Sentry token", reason: "", env_key: "SENTRY_AUTH_TOKEN", file: ".env", replaces: false })
  const state = useStore.getState()
  const current = state.transcript(threadId)
  state.set({ transcripts: { ...state.transcripts, [threadId]: { ...current, loaded: true, blocks: [...current.blocks, { kind: "approval", id: "approval:secret-3", turnId, at, seq: 300, approval: ended, decision: { decision: "deny", reason: "turn ended" } }] } } })
  await sleep(300)
  const lines = Array.from(document.querySelectorAll<HTMLElement>("[data-secret-outcome]")).map((line) => line.textContent)
  const secretSettledLines = lines.includes("Saved to .env as STRIPE_SECRET_KEY") && lines.includes("Declined OPENAI_API_KEY") && lines.includes("Request ended: the agent stopped before you answered")
  const secretNeverRendered = !document.body.textContent?.includes("sk_test_1234")
  await shot("secret-settled")
  return { secretFieldFocused, secretFieldHardened, secretCopy, digitsIgnored, secretRevealed, secretSubmitted, secretReplaceCopy, secretDeclined, secretSettledLines, secretNeverRendered }
}

const claudeDefault = { kind: "claude-code" as const, instance: "default" }
const sonnet = { provider: claudeDefault, model: "claude-sonnet-5-5" }
const opusHigh = { provider: claudeDefault, model: "claude-opus-5-5", effort: "high" }
const debug = (value: unknown) => {
  const target = window as unknown as { __chatCoordinatorDebug?: unknown[]; webkit?: { messageHandlers?: { bench?: { postMessage: (value: string) => void } } } }
  ;(target.__chatCoordinatorDebug ??= []).push(value)
  document.documentElement.dataset.fixtureDebug = JSON.stringify(target.__chatCoordinatorDebug)
  target.webkit?.messageHandlers?.bench?.postMessage(JSON.stringify({ stage: "debug", value }))
}
const lastCall = (method: string) => [...chatFixture.calls].reverse().find((call) => call.method === method)
const within = (root: ParentNode | null | undefined, selector: string, label: string) =>
  Array.from(root?.querySelectorAll<HTMLElement>(selector) ?? []).find((element) => visible(element) && (element.getAttribute("aria-label") === label || element.textContent?.trim() === label || element.textContent?.trim().startsWith(label)))
const key = (target: EventTarget, init: KeyboardEventInit) => target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }))
const responses = (id: string) => chatFixture.calls.filter((call) => call.method === "approvals.respond" && call.params.approval_id === id)

/**
 * 0.9.1: the Coordinator that sets itself up. Its cards (brief, settings, git), typed
 * /skills, the Setup started row, the default a delegation set aside, the Project tab's
 * Coordinator section, Settings defaults, and a stale plan-usage ring.
 */
async function checkCoordinatorSetup(threadId: string) {
  const turnId = "secret-turn"
  const state = () => useStore.getState()
  const show = (approval: ApprovalRequest) => {
    const current = state().transcript(threadId)
    state().set({ transcripts: { ...state().transcripts, [threadId]: { ...current, loaded: true, pendingApprovals: [approval], blocks: [...current.blocks, { kind: "approval", id: `approval:${approval.id}`, turnId, at, seq: 400 + current.blocks.length, approval, decision: null }] } } })
  }
  const request = (id: string, tool_name: string, input: Record<string, unknown>, summary = ""): ApprovalRequest => ({ id, thread_id: threadId, turn_id: turnId, tool_call_id: null, tool_name, input: input as never, summary, suggestions: [], created_at: at })
  const card = (kind: string) => document.querySelector<HTMLElement>(`[data-coordinator-card="${kind}"]`)
  const composerShown = () => { const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]'); return !!editor && visible(editor) && !editor.closest('[aria-hidden="true"], [inert]') }

  // ---- brief proposal: prefilled, editable, digits never answer it, ⌘↵ saves the edited text ----
  show(request("brief-1", "kybern_coordinator_brief", { text: "Kybern: desktop, daemon and mobile client for coding agents. Ship small PRs against main, one task each.\n\nPropose a plan before protocol changes, new dependencies or releases. Opus designs and reviews; Sonnet builds.", replaces: false })); await sleep(450)
  const briefField = card("brief")?.querySelector<HTMLTextAreaElement>("textarea")
  const briefPrefilled = !!briefField && briefField.value.startsWith("Kybern: desktop") && document.activeElement === briefField && card("brief")!.textContent!.includes("Save this as the project brief?")
  const briefHidesComposer = !composerShown()
  key(window, { key: "1" }); key(briefField!, { key: "3" }); await sleep(120)
  const briefDigitsIgnored = responses("brief-1").length === 0
  briefField!.focus(); briefField!.setSelectionRange(briefField!.value.length, briefField!.value.length)
  document.execCommand("insertText", false, " Check UI in light and dark.")
  await sleep(120)
  await shot("card-brief")
  key(briefField!, { key: "Enter", metaKey: true }); await sleep(300)
  const briefSaved = responses("brief-1")[0]?.params.decision === "submit" && String(responses("brief-1")[0]?.params.response?.text).endsWith("Opus designs and reviews; Sonnet builds. Check UI in light and dark.") && !card("brief")

  // ---- settings proposal: old → new, untick one, apply the rest ----
  show(request("settings-1", "kybern_coordinator_settings", { reason: "From your answers: plans before larger work, Opus for design, Sonnet to build.", changes: [
    { path: "lead_autonomy", label: "Before starting work", old: "act", new: "propose_large" },
    { path: "role_defaults.design", label: "Design model", old: null, new: opusHigh },
    { path: "role_defaults.implementation", label: "Implementation model", old: null, new: sonnet },
    { path: "lead_workspace", label: "Agents work in", old: "shared", new: "worktree" },
  ] })); await sleep(450)
  const settingsCard = card("settings")
  const settingsRows = Array.from(settingsCard?.querySelectorAll<HTMLElement>("[data-setting-change]") ?? []).map((row) => row.textContent)
  const settingsReadable = settingsRows.length === 4 && settingsRows[0] === "Before starting workAct→toPropose large" && settingsRows[1] === "Design modelDefault→toOpus 5.5 · high"
    && !!settingsCard?.querySelector("s") && getComputedStyle(settingsCard.querySelector("s")!).textDecorationLine.includes("line-through")
  settingsCard?.querySelector<HTMLElement>('[data-setting-change="lead_workspace"] [role="checkbox"]')?.click(); await sleep(150)
  await sleep(300)
  const applyButton = within(settingsCard, "button", "Apply")
  const applyCount = !!applyButton?.textContent?.includes("Apply 3 changes")
  await shot("card-settings")
  applyButton?.click(); await sleep(300)
  const settingsAnswer = responses("settings-1")[0]?.params
  const settingsPartial = applyCount && settingsAnswer?.decision === "submit" && JSON.stringify(settingsAnswer.response?.accepted) === JSON.stringify(["lead_autonomy", "role_defaults.design", "role_defaults.implementation"])

  // ---- git: push answers like a permission; no "for this session" ----
  show(request("git-push", "kybern_git", { op: "push", remote: "origin", branch: "fix/settings-sheet-rotation", ahead: 3 }, "Push fix/settings-sheet-rotation to origin (3 commits to send)")); await sleep(450)
  const pushCopy = card("git-push")?.textContent?.includes("Push fix/settings-sheet-rotation?") && card("git-push")?.textContent?.includes("3 commits to send to origin.")
  const pushKeepsComposer = composerShown()
  document.querySelector<HTMLElement>('[data-testid="composer-editor"]')?.blur()
  await shot("card-git-push")
  key(window, { key: "2" }); await sleep(120)
  const pushNoSessionAllow = responses("git-push").length === 0
  key(window, { key: "1" }); await sleep(300)
  const pushAllowed = responses("git-push")[0]?.params.decision === "allow_once"

  // ---- git: open a pull request, declined ----
  show(request("git-pr", "kybern_git", { op: "open_pr", remote: "origin", branch: "fix/settings-sheet-rotation", ahead: 3, title: "Fix settings sheet crash on iPad rotation", body: "Keeps the sheet's detent when the size class changes and adds a rotation test.", base: "main" })); await sleep(450)
  const prPreview = !!card("git-open_pr")?.textContent?.includes("Fix settings sheet crash on iPad rotation") && !!card("git-open_pr")?.textContent?.includes("3 commits ahead of main on origin.") && !!within(card("git-open_pr"), "button", "Push and open PR")
  within(card("git-open_pr"), "button", "Decline")?.click(); await sleep(300)
  const prDeclined = responses("git-pr")[0]?.params.decision === "deny"

  // ---- git: merge a PR; no digit, a destructive button ----
  show(request("git-merge", "kybern_git", { op: "merge_pr", number: 106, title: "Fix settings sheet crash on iPad rotation", checks: { total: 6, passed: 6, failed: 0, pending: 0, skipped: 0 }, method: "squash" })); await sleep(450)
  const mergeCard = card("git-merge_pr")
  key(window, { key: "1" }); await sleep(150)
  const mergeDigitIgnored = responses("git-merge").length === 0
  const mergeButton = within(mergeCard, "button", "Merge PR")
  const mergeCopy = !!mergeCard?.textContent?.includes("Squash-merge PR #106?") && !!mergeCard.textContent.includes("6 checks passed") && !!mergeCard.textContent.includes("This can't be undone from Kybern.") && !!mergeButton?.className.includes("bg-destructive")
  await shot("card-git-merge")
  mergeButton?.click(); await sleep(300)
  const mergeAllowed = responses("git-merge")[0]?.params.decision === "allow_once"
  const lines = Array.from(document.querySelectorAll<HTMLElement>("[data-coordinator-card-outcome]")).map((line) => line.textContent)
  const cardLinesSettled = ["Saved the project brief", "Applied 3 Coordinator settings", "Pushed fix/settings-sheet-rotation", "Declined opening a pull request for fix/settings-sheet-rotation", "Merged PR #106"].every((line) => lines.includes(line))

  // ---- a typed /skill sends as the skill ----
  write("please /review the sign-in flow"); await sleep(200)
  key(document.querySelector<HTMLElement>('[data-testid="composer-editor"]')!, { key: "Enter" }); await sleep(300)
  const slashParts = chatFixture.sent.at(-1)?.message.parts
  debug({ slashParts, sentCount: chatFixture.sent.length })
  const typedSlashSkill = JSON.stringify(slashParts) === JSON.stringify([{ type: "text", text: "please " }, { type: "skill", name: "review", path: "/skills/review" }, { type: "text", text: "the sign-in flow" }])

  // ---- Setup started, then the user's own words as their bubble ----
  const setupTurn = "setup-turn"
  const child: Thread = thread("override-child", "Fix settings sheet crash", { parent_thread_id: threadId, model: "claude-opus-5-5", status: "running", delegation: { task_id: "task-override", operation_id: "op-override", parent_thread_id: threadId, depth: 1, role: "implementation", workspace: "worktree", status: "running", started_at: at, default_override: { provider: claudeDefault, model: "claude-sonnet-5-5", reason: "The crash repro needs deeper reasoning across iPad layouts." } } })
  {
    const current = state().transcript(threadId)
    state().set({ threads: { ...state().threads, [child.id]: child }, transcripts: { ...state().transcripts, [threadId]: { ...current, pendingApprovals: [], blocks: [...current.blocks,
      { kind: "user", id: "setup-user", turnId: setupTurn, at, seq: 900, message: { parts: [{ type: "system_row", kind: "coordinator_setup", text: "Setup started" }, { type: "text", text: "we're building kybern, I mostly want small PRs and Opus for design" }] } },
      { kind: "assistant", id: "setup-answer#0", messageId: "setup-answer", segment: 0, thinking: "", turnId: setupTurn, at, seq: 901, origin: { kind: "root" }, text: "Thanks. I've read `AGENTS.md` and `CLAUDE.md`, so I'll skip what they already cover. A research agent is learning how to build and test the repo in the meantime.", complete: true },
    ] } } })
  }
  await sleep(500)
  const systemRow = document.querySelector<HTMLElement>('[data-system-row="coordinator_setup"]')
  const userBubbles = Array.from(document.querySelectorAll<HTMLElement>('[data-message-role="user"] [data-slot="message-content"]')).map((bubble) => bubble.textContent ?? "")
  const setupRowShown = !!systemRow && systemRow.textContent === "Setup started" && userBubbles.some((text) => text.includes("we're building kybern")) && !userBubbles.some((text) => text.includes("Setup started"))
  await shot("setup-row")

  // ---- the default a delegation set aside ----
  {
    const current = state().transcript(threadId)
    state().set({ transcripts: { ...state().transcripts, [threadId]: { ...current, blocks: [...current.blocks,
      { kind: "tool", id: "tool:delegate-override", turnId: setupTurn, at, seq: 902, origin: { kind: "root" }, call: { id: "delegate-override", name: "mcp__kybern__kybern_agent_delegate", input: { task: "Fix the settings sheet crash on rotation", title: child.title, role: "implementation", workspace: "worktree", provider: "claude-code", model: "claude-opus-5-5", override_reason: "The crash repro needs deeper reasoning across iPad layouts." } }, stream: "", isError: false, complete: true, output: { content: [{ type: "text", text: JSON.stringify({ task_id: "task-override", thread_id: child.id, title: child.title, provider: "claude-code", model: "claude-opus-5-5", workspace: "worktree", status: "running" }) }] } },
    ] } } })
  }
  await sleep(500)
  const overrideLine = document.querySelector<HTMLElement>("[data-default-override]")
  const launchOverride = overrideLine?.textContent === "Instead of the Sonnet 5.5 default: The crash repro needs deeper reasoning across iPad layouts."
    && !!overrideLine.closest("[data-delegation-launch]")?.textContent?.includes("Opus 5.5")
  await shot("launch-override")

  // ---- the Project tab's Coordinator section ----
  const settings = { default_provider: "claude-code", default_permission_mode: "supervised", worktrees_default: false, generate_titles: true, providers: {}, notifications: true, auto_update_harnesses: false, auto_update_daemon: false, tell_agents_about_kybern: true, orchestration: { max_active_children: 4, lead_max_children: 6, max_depth: 2, lead_autonomy: "propose_large", lead_workspace: "shared", lead_push_without_asking: false, role_defaults: { research: sonnet } } } as unknown as Settings
  state().set({ settings, rightOpen: true, rightTabs: ["agents", "project"], rightTab: "project" }); await sleep(450)
  const section = () => document.querySelector<HTMLElement>("[data-coordinator-section]")
  section()?.scrollIntoView({ block: "start" }); await sleep(100)
  const radio = (label: string) => within(section(), '[role="radio"]', label)
  const chip = (role: string) => section()?.querySelector<HTMLElement>(`[data-role-chip="${role}"]`)
  const hint = () => section()?.querySelector("[data-autonomy-hint]")?.textContent
  const sectionInitial = radio("Propose large")?.getAttribute("aria-checked") === "true" && hint() === "Small fixes start right away. Larger work and protocol changes get a plan first."
    && radio("This checkout")?.getAttribute("aria-checked") === "true"
    && chip("research")?.textContent === "Default · Sonnet 5.5" && chip("research")?.dataset.roleChipKind === "inherited"
    && chip("implementation")?.textContent === "Same as the Coordinator"
    && !!section()?.textContent?.includes("Merging a pull request always asks.") && !!section()?.textContent?.includes("Defaults come from Settings › Delegation")
  await shot("project-coordinator-section")
  const updates = () => chatFixture.calls.filter((call) => call.method === "projects.update" && "coordinator" in call.params)
  radio("Act")?.click(); await sleep(250)
  const autonomyWrite = JSON.stringify(updates().at(-1)?.params.coordinator) === JSON.stringify({ lead_autonomy: "act" }) && hint() === "Starts work right away and reports when it's done."
  radio("Own worktree")?.click(); await sleep(250)
  const workspaceWrite = JSON.stringify(updates().at(-1)?.params.coordinator) === JSON.stringify({ lead_autonomy: "act", lead_workspace: "worktree" })
  section()?.querySelector<HTMLElement>('[role="switch"]')?.click(); await sleep(250)
  debug({ updates: updates().map((call) => call.params), hint: hint() })
  const pushWrite = JSON.stringify(updates().at(-1)?.params.coordinator) === JSON.stringify({ lead_autonomy: "act", lead_workspace: "worktree", lead_push_without_asking: true })
  chip("implementation")?.click(); await sleep(350)
  const pickerDefaultRow = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).some((option) => visible(option) && option.textContent?.startsWith("Use the default"))
  Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((option) => visible(option) && option.textContent?.startsWith("Opus 5.5"))?.click(); await sleep(350)
  const roleWritten = updates().at(-1)?.params.coordinator?.role_defaults?.implementation
  const roleWrite = roleWritten?.model === "claude-opus-5-5" && roleWritten?.provider?.kind === "claude-code" && updates().at(-1)?.params.coordinator?.lead_push_without_asking === true
    && chip("implementation")?.dataset.roleChipKind === "set" && !!chip("implementation")?.textContent?.startsWith("Opus 5.5")
  chip("implementation")?.click(); await sleep(350)
  Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((option) => visible(option) && option.textContent?.startsWith("Use the default"))?.click(); await sleep(350)
  const roleReset = !updates().at(-1)?.params.coordinator?.role_defaults && chip("implementation")?.textContent === "Same as the Coordinator"
  // A refused write rolls back and says what to do next.
  chatFixture.failProjectUpdate = true
  radio("Propose all")?.click(); await sleep(400)
  chatFixture.failProjectUpdate = false
  const writeRollsBack = radio("Act")?.getAttribute("aria-checked") === "true" && !!document.body.textContent?.includes("Unable to save the Coordinator settings. Check the connection and try again.")
  // Reset asks first, then clears every override.
  within(section(), "button", "Reset")?.click(); await sleep(300)
  const resetConfirm = within(document.querySelector('[data-slot="popover-popup"]'), "button", "Reset")
  const resetAsks = !!document.querySelector('[data-slot="popover-popup"]')?.textContent?.includes("Reset this project's Coordinator settings?")
  resetConfirm?.click(); await sleep(350)
  const resetWrite = resetAsks && updates().at(-1)?.params.coordinator === null && radio("Propose large")?.getAttribute("aria-checked") === "true"
  // Redo setup asks, then starts the interview; while the Coordinator works it says to wait.
  within(section()?.closest("section"), "button", "Redo setup")?.click(); await sleep(300)
  const redoAsks = !!document.querySelector('[data-slot="popover-popup"]')?.textContent?.includes("The Coordinator will interview you again. Your brief stays until you save a new one.")
  within(document.querySelector('[data-slot="popover-popup"]'), "button", "Redo setup")?.click(); await sleep(300)
  const redoCalled = redoAsks && lastCall("coordinator.setup")?.params.project_id === "project-0"
  chatFixture.setupBusy = true
  within(section()?.closest("section"), "button", "Redo setup")?.click(); await sleep(300)
  within(document.querySelector('[data-slot="popover-popup"]'), "button", "Redo setup")?.click(); await sleep(500)
  chatFixture.setupBusy = false
  const redoBusyToast = !!document.body.textContent?.includes("Wait for the Coordinator to finish, then try again.")
  state().set({ rightOpen: false }); await sleep(200)

  // ---- Settings › Delegation: Coordinator defaults ----
  toast.dismiss(); await sleep(300)
  const overlay = document.createElement("div")
  overlay.setAttribute("data-fixture-overlay", "")
  overlay.style.cssText = "position:fixed;inset:0;z-index:40;overflow:auto;background:var(--background)"
  document.body.append(overlay)
  const overlayRoot = createRoot(overlay)
  function SettingsOverlay() {
    const { settings: current, update } = useSettings()
    return current ? <div className="settings-page mx-auto max-w-[720px] px-8 py-8 font-system-ui"><CoordinatorDefaultsSection settings={current} onChange={(orchestration) => update({ orchestration })} /></div> : null
  }
  flushSync(() => overlayRoot.render(<ThemeProviderContext value={{ theme, translucent: false, setTheme: () => {}, setTranslucent: () => {} }}><SettingsOverlay /></ThemeProviderContext>))
  await sleep(400)
  const defaults = () => overlay
  const defaultsShown = within(defaults(), '[role="radio"]', "Propose large")?.getAttribute("aria-checked") === "true"
    && defaults().querySelector<HTMLElement>('[data-role-chip="research"]')?.textContent === "Sonnet 5.5"
    && defaults().querySelector<HTMLElement>('[data-role-chip="review"]')?.textContent === "Same as the Coordinator"
  await shot("settings-defaults")
  within(defaults(), '[role="radio"]', "Propose all")?.click(); await sleep(300)
  const savedSettings = lastCall("settings.update")?.params.settings?.orchestration
  debug({ savedSettings, settingsCalls: chatFixture.calls.filter((call) => call.method === "settings.update").length, radios: Array.from(defaults().querySelectorAll('[role="radio"]')).map((r) => `${r.textContent}:${r.getAttribute("aria-checked")}`) })
  const settingsDefaultsWrite = savedSettings?.lead_autonomy === "propose_first" && savedSettings?.role_defaults?.research?.model === "claude-sonnet-5-5" && savedSettings?.max_depth === 2
  overlayRoot.unmount(); overlay.remove()

  // ---- a stale plan-usage ring stays, dimmed, and says why ----
  const rail = document.createElement("div")
  rail.style.cssText = "position:fixed;inset:0;z-index:40;background:var(--background);display:flex;align-items:flex-end;padding:24px"
  document.body.append(rail)
  const railRoot = createRoot(rail)
  const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString()
  const resetsAt = Date.now() / 1000 + 3 * 3600
  useUsageLimits.setState({ ownerKey: state().environmentId, loaded: true, refreshing: [], accounts: [], providers: [
    { provider: "claude-code", limits: [{ name: "Current session", used_percent: 42, window_minutes: 300, resets_at: resetsAt }], updated_at: twoHoursAgo, source: "live", stale: "login_refresh" },
    { provider: "codex", limits: [{ name: "Current session", used_percent: 18, window_minutes: 300, resets_at: resetsAt }], updated_at: new Date().toISOString(), source: "live" },
  ] as never })
  flushSync(() => railRoot.render(<ThemeProviderContext value={{ theme, translucent: false, setTheme: () => {}, setTranslucent: () => {} }}><div className="flex w-14 flex-col items-center rounded-xl bg-[var(--app-rail-background,transparent)] py-2"><RailUsage /></div></ThemeProviderContext>))
  await sleep(300)
  const claudeRing = rail.querySelector<HTMLElement>('[data-testid="rail-usage-claude-code"] .rail-usage-ring')
  const codexRing = rail.querySelector<HTMLElement>('[data-testid="rail-usage-codex"] .rail-usage-ring')
  const staleRingDimmed = !!claudeRing && !!codexRing && claudeRing.hasAttribute("data-stale") && getComputedStyle(claudeRing).opacity === "0.5" && getComputedStyle(codexRing).opacity === "1"
    && getComputedStyle(claudeRing.querySelector(".rail-usage-arc")!).stroke === getComputedStyle(codexRing.querySelector(".rail-usage-arc")!).stroke
    && rail.querySelector('[data-testid="rail-usage-claude-code"]')?.getAttribute("aria-label") === "Claude Code: 58% left. Last updated 2 h ago. Waiting for Claude Code to refresh its sign-in."
  rail.querySelector<HTMLElement>('[data-testid="rail-usage-claude-code"]')?.click(); await sleep(450)
  const staleCaptionShown = document.querySelector("[data-limits-caption]")?.textContent === "Last updated 2 h ago. Waiting for Claude Code to refresh its sign-in."
  await shot("stale-ring")
  railRoot.unmount(); rail.remove()

  return { briefPrefilled, briefHidesComposer, briefDigitsIgnored, briefSaved, settingsReadable, settingsPartial, pushCopy, pushKeepsComposer, pushNoSessionAllow, pushAllowed, prPreview, prDeclined, mergeDigitIgnored, mergeCopy, mergeAllowed, cardLinesSettled, typedSlashSkill, setupRowShown, launchOverride, sectionInitial, autonomyWrite, workspaceWrite, pushWrite, pickerDefaultRow, roleWrite, roleReset, writeRollsBack, resetWrite, redoCalled, redoBusyToast, defaultsShown, settingsDefaultsWrite, staleRingDimmed, staleCaptionShown }
}

window.addEventListener("unhandledrejection", (event) => results({ pass: false, error: String(event.reason), stack: String(event.reason?.stack ?? "") }))
run().catch((error) => results({ fixture: "chat-coordinator", pass: false, error: String(error) }))
