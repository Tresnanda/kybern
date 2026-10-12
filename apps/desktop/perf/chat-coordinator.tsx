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
import { chatFixture } from "./chat-coordinator-rpc"
import type { Thread, Project, ProviderStatus } from "../src/protocol"
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
  target.webkit?.messageHandlers?.bench?.postMessage(JSON.stringify(value))
}
const sampleMemory = (stage: string) => new Promise<void>((resolve) => {
  const target = window as unknown as { __memoryContinue?: () => void; webkit?: { messageHandlers?: { bench?: { postMessage: (value: string) => void } } } }
  target.__memoryContinue = resolve
  target.webkit?.messageHandlers?.bench?.postMessage(JSON.stringify({ stage, memory: true }))
})
const projects: Record<string, Project> = Object.fromEntries(["Kybern", "Website"].map((name, index) => [`project-${index}`, { id: `project-${index}`, name, path: "/project", is_git: true, created_at: at, updated_at: at }]))
const thread = (id: string, title: string, extra: Partial<Thread> = {}): Thread => ({ id, title, project_id: "project-0", provider: { kind: "claude-code", instance: "default" }, permission_mode: "supervised", status: "idle", cwd: "/project", pinned: false, created_at: at, updated_at: at, last_seq: 0, ...extra })
const threads: Record<string, Thread> = {
  main: thread("main", "Improve sign-in"),
  worker: thread("worker", "Implement sign-in", { parent_thread_id: "main", status: "running", provider: { kind: "codex", instance: "default" } }),
  reviewer: thread("reviewer", "Review sign-in", { parent_thread_id: "main", status: "running" }),
  previous: thread("previous", "Authentication decisions"),
  other: thread("other", "Authentication decisions", { project_id: "project-1", provider: { kind: "codex", instance: "default" } }),
}
const providers: ProviderStatus[] = [
  { kind: "claude-code", display_name: "Claude Code", available: true, supported_permission_modes: ["supervised", "full-access"], supports_fork: true, supports_model_switch: true, instances: ["default"], models: [{ id: "default", display_name: "Default model", is_default: true }] },
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
  return <ThemeProviderContext value={{ theme, translucent: false, setTheme: () => {}, setTranslucent: () => {} }}><SidebarProvider><Sidebar><ThreadSidebar /></Sidebar><main className="flex h-screen min-w-0 flex-1 flex-col">{selected.kind === "draft" ? <Draft key={`${selected.draft.projectId}:${selected.draft.purpose}`} projectId={selected.draft.projectId} purpose={selected.draft.purpose} /> : <ThreadView key={id ?? "main"} threadId={id ?? "main"} />}</main>{rightOpen && <aside className="h-screen w-[440px] border-s border-[color:var(--app-surface-divider)]"><RightPanel threadId={id} /></aside>}</SidebarProvider></ThemeProviderContext>
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
  flushSync(() => createRoot(document.getElementById("root")!, { onUncaughtError: (error) => results({ pass: false, error: String(error) }) }).render(<Shell />))
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
  const coordinatorDraftInert = document.body.textContent?.includes("What should we work on in") && document.body.textContent?.includes("Your first message becomes the project brief") && chatFixture.coordinatorCreates === 0 && chatFixture.sent.length === 1
  const settledSidebarRowsCrisp = Array.from(document.querySelectorAll<HTMLElement>("[data-marquee-host]")).every((row) => getComputedStyle(row).filter === "none")
  if (preview === "coordinator-draft") return results({ preview, pass: coordinatorDraftInert && settledSidebarRowsCrisp, settledSidebarRowsCrisp })
  await click("Change model and reasoning"); await sleep(120)
  const allHarnessesVisible = ["Claude Code", "Codex", "Cursor", "OpenCode", "Pi", "Oh My Pi"].every((label) => !!findButton(label))
  if (preview === "coordinator-harness") return results({ preview, pass: allHarnessesVisible })
  await click("Codex"); await sleep(120)
  const editsNotBlockedTooltip = !!document.querySelector('[title*="can\'t block file edits"]')
  write("Plan and ship the local coordinator experience.")
  document.querySelector<HTMLTextAreaElement>('[data-testid="composer-editor"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await sleep(350)
  const coordinator = useStore.getState().threads["project-coordinator"]
  const coordinatorOpensChat = (useStore.getState().selected as { id: string }).id === coordinator?.id && !!document.querySelector('[data-testid="composer-editor"]')
  const editsNotBlockedPill = !!Array.from(document.querySelectorAll<HTMLElement>('[data-slot="badge"]')).find((element) => element.textContent?.trim() === "Edits not blocked on Codex")
  const initialBriefPreserved = chatFixture.calls.some((call) => call.method === "coordinator.open" && call.params.initial_brief === "Plan and ship the local coordinator experience.")
  const stableFirstMessageId = !!chatFixture.sent[1]?.messageId
  await click("Change model and reasoning"); await sleep(100); await click("Claude Code"); await sleep(250)
  const harnessSwitched = useStore.getState().threads["project-coordinator"]?.provider.kind === "claude-code" && chatFixture.calls.some((call) => call.method === "coordinator.switch_harness")
  const editsPillGoneOnClaude = !Array.from(document.querySelectorAll<HTMLElement>('[data-slot="badge"]')).some((element) => element.textContent?.includes("Edits not blocked"))
  const oneCoordinatorCreated = chatFixture.coordinatorCreates === 1
  const projectTabOnlyForCoordinator = await (async () => {
    useStore.getState().set({ rightOpen: true, rightTabs: ["agents", "project"], rightTab: "project" }); await sleep(300)
    const coordinatorHasProject = !!document.querySelector("[data-project-panel]")
    useStore.getState().selectThread("main"); await sleep(300)
    const ordinaryHasNone = !document.querySelector("[data-project-panel]") && useStore.getState().rightTab === "project"
    useStore.getState().selectThread(coordinator.id); await sleep(200)
    return coordinatorHasProject && ordinaryHasNone
  })()
  const horizontalOverflow = Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
  const checks = { ...dockChecks, initialHasNoSetup, composerSingleLineEditorInTwoLineFrame, blankComposerAreaFocusesEditor, childReturn, titleOnlyReference, referenceDidNotWake, typedReferenceSent, coordinatorDraftInert, settledSidebarRowsCrisp, allHarnessesVisible, editsNotBlockedTooltip, coordinatorOpensChat, editsNotBlockedPill, initialBriefPreserved, stableFirstMessageId, harnessSwitched, editsPillGoneOnClaude, oneCoordinatorCreated, projectTabOnlyForCoordinator, noHorizontalOverflow: horizontalOverflow <= 1 }
  results({ fixture: "chat-coordinator", pass: Object.values(checks).every(Boolean), checks, horizontalOverflow })
}
window.addEventListener("unhandledrejection", (event) => results({ pass: false, error: String(event.reason) }))
run().catch((error) => results({ fixture: "chat-coordinator", pass: false, error: String(error) }))
