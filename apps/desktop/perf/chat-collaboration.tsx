/* eslint-disable react-refresh/only-export-components */
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { ThreadView } from "../src/views/Thread"
import { Draft } from "../src/views/Draft"
import { RightPanel } from "../src/views/RightPanel"
import { ThreadSidebar } from "../src/views/Sidebar"
import { Sidebar, SidebarProvider } from "../src/components/kit/sidebar"
import { ThemeProviderContext } from "../src/components/theme-context"
import { buildThemeCssVariables, DEFAULT_THEME_STATE } from "../src/lib/kit/theme/theme.logic"
import { useStore } from "../src/state/store"
import { useEnvironments } from "../src/state/environments"
import { emptyThreadState } from "../src/state/transcript"
import { chatFixture } from "./chat-collaboration-rpc"
import type { Thread, Project, ProviderStatus } from "../src/protocol"
import "../src/index.css"

const query = new URLSearchParams(location.search)
declare const __COLLAB_THEME__: "dark" | "light"
declare const __COLLAB_VIEW__: string
const theme = (query.get("theme") ?? __COLLAB_THEME__) === "light" ? "light" : "dark"
const preview = query.get("view") ?? __COLLAB_VIEW__
const at = "2026-09-14T10:00:00Z"
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const results = (value: unknown) => {
  const target = window as unknown as { __chatCollaborationResults?: unknown[]; webkit?: { messageHandlers?: { bench?: { postMessage: (value: string) => void } } } }
  ;(target.__chatCollaborationResults ??= []).push(value)
  target.webkit?.messageHandlers?.bench?.postMessage(JSON.stringify(value))
}
const projects: Record<string, Project> = Object.fromEntries(["Kybern", "Website"].map((name, index) => [`project-${index}`, { id: `project-${index}`, name, path: "/project", is_git: true, created_at: at, updated_at: at }]))
const thread = (id: string, title: string, extra: Partial<Thread> = {}): Thread => ({ id, title, project_id: "project-0", provider: { kind: "claude-code", instance: "default" }, permission_mode: "supervised", status: "idle", cwd: "/project", pinned: false, created_at: at, updated_at: at, last_seq: 0, ...extra })
const threads: Record<string, Thread> = {
  main: thread("main", "Improve sign-in", { collaboration_group_id: "work-group" }),
  worker: thread("worker", "Implement sign-in", { parent_thread_id: "main", collaboration_group_id: "work-group", status: "running", provider: { kind: "codex", instance: "default" } }),
  reviewer: thread("reviewer", "Review sign-in", { parent_thread_id: "main", collaboration_group_id: "work-group", status: "running" }),
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
  const editor = document.querySelector<HTMLTextAreaElement>('[data-testid="composer-editor"]')!
  editor.focus()
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, value)
  editor.setSelectionRange(value.length, value.length)
  editor.dispatchEvent(new Event("input", { bubbles: true }))
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
  const initialHasNoSetup = !document.body.textContent?.includes("Let agent start helpers") && !!document.querySelector('[data-testid="composer-editor"]')
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
  const agentMessage = { parts: [{ type: "text" as const, text: `Kybern collaboration Result from thread ${messageId} (message ${messageId}, reply_to None):\nReviewed sign-in. All checks passed.` }] }
  useStore.getState().set({ queued: { main: [{ id: messageId, message: agentMessage }] } }); await sleep(150)
  const queueToggle = findButton("1 agent update waiting")
  const updatesInitiallyCollapsed = !!queueToggle && !document.querySelector('[data-testid="queued-follow-up-row"]')
  queueToggle?.click(); await sleep(150)
  const updateRow = document.querySelector('[data-testid="queued-follow-up-row"]')
  const updatesReadable = updateRow?.textContent?.includes("Result · Helper") && !updateRow?.textContent?.includes(messageId)
  const originalTranscript = useStore.getState().transcripts.main
  useStore.getState().set({ transcripts: { ...useStore.getState().transcripts, main: { ...originalTranscript, blocks: [
    ...originalTranscript.blocks,
    { kind: "user", id: "agent-update", turnId: "update-turn", at, seq: 4, message: agentMessage },
    { kind: "turn_end", id: "update-end", turnId: "update-turn", at, seq: 5, stopReason: "completed", usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, costUsd: null, durationMs: 0, terminalMessageId: null, error: null },
  ] } } }); await sleep(300)
  const notice = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')).find(button => button.textContent?.trim() === "Result · Helper" && !button.closest('[data-testid="queued-follow-up-row"]'))
  const messageInitiallyCollapsed = !!notice && notice.getAttribute("aria-expanded") === "false"
  notice?.click(); await sleep(500)
  const messageReadable = document.body.textContent?.includes("Reviewed sign-in. All checks passed.") && !!document.querySelector('details summary')
  if (preview === "disclosure") return results({ preview, pass: sidebarDisclosure && updatesInitiallyCollapsed && updatesReadable && messageInitiallyCollapsed && messageReadable })
  notice?.click(); await sleep(320)
  const messageUnmounted = !document.body.textContent?.includes("Reviewed sign-in. All checks passed.")
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
  const noDuplicatePanels = dock().querySelectorAll("[data-tab-active]").length === 2 && useStore.getState().rightTab === "collaboration"
  await click("Collapse panel")
  useStore.getState().set({ rightOpen: true }); await sleep(220)
  const dockReopensChoices = dock().querySelectorAll("[data-tab-active]").length === 2 && useStore.getState().rightTab === "collaboration"
  await click("Close Agents panel")
  const closeSelectsNeighbor = useStore.getState().rightTab === "changes" && dock().querySelectorAll(".t-pane").length === 1
  await click("Close Diff panel")
  const closeLastEmptiesDock = dock().textContent?.includes("Add a panel with +.") && dock().querySelectorAll(".t-pane").length === 0 && document.activeElement?.getAttribute("aria-label") === "Add panel"
  const dockChecks = { messageInitiallyCollapsed, messageReadable, messageUnmounted, sidebarDisclosure, updatesInitiallyCollapsed, updatesReadable, emptyDock, firstPanel, noDuplicatePanels, dockReopensChoices, closeSelectsNeighbor, closeLastEmptiesDock }
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
  const editor = document.querySelector<HTMLTextAreaElement>('[data-testid="composer-editor"]')!
  const titleOnlyReference = editor.value.includes("Authentication decisions") && !editor.value.includes("@thread[")
  const referenceDidNotWake = chatFixture.sent.length === 0 && !chatFixture.calls.some((call) => call.method === "threads.send")
  editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await sleep(200)
  const typedReferenceSent = chatFixture.sent[0]?.message.parts.some((part) => part.type === "thread_reference" && part.thread_id === "previous")
  if (!findButton("Create coordinator") && !preview.startsWith("coordinator-")) {
    const horizontalOverflow = Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
    const checks = { ...dockChecks, initialHasNoSetup, childReturn, titleOnlyReference, referenceDidNotWake, typedReferenceSent, noHorizontalOverflow: horizontalOverflow <= 1 }
    return results({ fixture: "chat-collaboration", pass: Object.values(checks).every(Boolean), checks, horizontalOverflow, coordinatorTest: "Covered in the wide sidebar fixture" })
  }
  if (findButton("Create coordinator")) await click("Create coordinator")
  else useStore.getState().selectDraft("project-0", "coordinator")
  await sleep(850)
  const coordinatorDraftInert = document.body.textContent?.includes("What should we work on in") && document.body.textContent?.includes("Project coordinator") && chatFixture.coordinatorCreates === 0 && chatFixture.sent.length === 1
  const settledSidebarRowsCrisp = Array.from(document.querySelectorAll<HTMLElement>("[data-marquee-host]")).every((row) => getComputedStyle(row).filter === "none")
  if (preview === "coordinator-draft") return results({ preview, pass: coordinatorDraftInert && settledSidebarRowsCrisp, settledSidebarRowsCrisp })
  await click("Change model and reasoning"); await sleep(120)
  const allHarnessesVisible = ["Claude Code", "Codex", "Cursor", "OpenCode", "Pi", "Oh My Pi"].every((label) => !!findButton(label))
  if (preview === "coordinator-harness") return results({ preview, pass: allHarnessesVisible })
  await click("Codex"); await sleep(120)
  const advisoryRestrictionVisible = !!document.querySelector('[title*="coordination-only role is advisory"]')
  write("Plan and ship the local coordinator experience.")
  document.querySelector<HTMLTextAreaElement>('[data-testid="composer-editor"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await sleep(350)
  const coordinator = useStore.getState().threads["project-coordinator"]
  const coordinatorOpensChat = (useStore.getState().selected as { id: string }).id === coordinator?.id && !!document.querySelector('[data-testid="composer-editor"]')
  const initialGoalPreserved = chatFixture.calls.some((call) => call.method === "collaboration.coordinator.get_or_create" && call.params.initial_goal === "Plan and ship the local coordinator experience.")
  const setupVisible = document.body.textContent?.includes("Project setup")
  chatFixture.completeSetup(); await sleep(250)
  const setupCompletes = document.body.textContent?.includes("Setup complete")
  const stableFirstMessageId = !!chatFixture.sent[1]?.messageId
  await click("Change model and reasoning"); await sleep(100); await click("Claude Code"); await sleep(250)
  const harnessSwitched = useStore.getState().threads["project-coordinator"]?.provider.kind === "claude-code" && chatFixture.calls.some((call) => call.method === "collaboration.coordinator.switch_harness")
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await sleep(250)
  await click("Knowledge"); await sleep(900)
  document.querySelectorAll<HTMLElement>('[data-slot="tooltip-positioner"],[role="tooltip"]').forEach((element) => { element.style.display = "none" })
  const projectKnowledgeVisible = document.body.textContent?.includes("Current plan") && document.body.textContent?.includes("Confirm the local workflow") && document.body.textContent?.includes("The draft stays inert until Send")
  if (preview === "coordinator-knowledge") return results({ preview, pass: projectKnowledgeVisible })
  await click("Results"); await sleep(700)
  const resultsVisible = document.body.textContent?.includes("Review coordinator integration") && document.body.textContent?.includes("Verified the inert draft")
  if (preview === "coordinator-results") return results({ preview, pass: resultsVisible })
  const oneCoordinatorCreated = chatFixture.coordinatorCreates === 1
  await click("More agent actions"); await sleep(150)
  const deleteMenu = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((element) => visible(element) && element.textContent?.includes("Delete coordinator"))
  if (!deleteMenu) throw new Error("Missing coordinator deletion action")
  deleteMenu.click(); await sleep(250)
  const deleteCopyClear = document.querySelector('[role="dialog"]')?.textContent?.includes("new coordinator starts with fresh knowledge")
  if (preview === "coordinator-delete") return results({ preview, pass: !!deleteCopyClear })
  await click("Cancel")
  const cancelledDeletionInert = !chatFixture.calls.some((call) => call.method === "collaboration.coordinator.delete")
  await click("More agent actions"); await sleep(120)
  Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((element) => visible(element) && element.textContent?.includes("Delete coordinator"))!.click(); await sleep(200)
  chatFixture.deleteError = true
  await click("Delete coordinator")
  const deleteErrorVisible = document.querySelector('[role="alert"]')?.textContent?.includes("Stop agents")
  chatFixture.deleteError = false
  await click("Delete coordinator"); await sleep(350)
  const deletionCalls = chatFixture.calls.filter((call) => call.method === "collaboration.coordinator.delete")
  const retryPreservesIdentity = deletionCalls.length === 2 && deletionCalls[0].params.operation_id === deletionCalls[1].params.operation_id && deletionCalls[1].params.thread_id === coordinator.id
  const coordinatorRemoved = useStore.getState().threads[coordinator.id]?.status === "archived" && !useStore.getState().threads[coordinator.id]?.coordinator_project_id && !!findButton("Create coordinator")
  await click("Create coordinator"); await sleep(250)
  const recreationDraftInert = chatFixture.coordinatorCreates === 1 && !!document.querySelector('[data-testid="composer-editor"]')
  const horizontalOverflow = Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
  const checks = { ...dockChecks, initialHasNoSetup, childReturn, titleOnlyReference, referenceDidNotWake, typedReferenceSent, coordinatorDraftInert, settledSidebarRowsCrisp, allHarnessesVisible, advisoryRestrictionVisible, coordinatorOpensChat, initialGoalPreserved, stableFirstMessageId, harnessSwitched, projectKnowledgeVisible, resultsVisible, oneCoordinatorCreated, setupVisible, setupCompletes, deleteCopyClear, cancelledDeletionInert, deleteErrorVisible, retryPreservesIdentity, coordinatorRemoved, recreationDraftInert, noHorizontalOverflow: horizontalOverflow <= 1 }
  results({ fixture: "chat-collaboration", pass: Object.values(checks).every(Boolean), checks, horizontalOverflow })
}
window.addEventListener("unhandledrejection", (event) => results({ pass: false, error: String(event.reason) }))
run().catch((error) => results({ fixture: "chat-collaboration", pass: false, error: String(error) }))
