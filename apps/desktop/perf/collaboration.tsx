import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { CollaborationPane } from "../src/views/Collaboration"
import { buildThemeCssVariables, DEFAULT_THEME_STATE } from "../src/lib/kit/theme/theme.logic"
import { useStore } from "../src/state/store"
import type { Project, ProviderStatus, Thread } from "../src/protocol"
import { collaborationFixtureState, emitThreadMetadataUpdates, refreshCollaborationFixture, rpc as fixtureRpc } from "./collaboration-rpc"
import { collaborationReplay } from "./collaboration-replay"
import "../src/index.css"

declare const __COLLAB_THEME__: "dark" | "light"
declare const __COLLAB_VIEW__: string
declare const __COLLAB_STRESS__: string
const query = new URLSearchParams(location.search)
const captureView = query.get("view") ?? __COLLAB_VIEW__
const captureTheme = (query.get("theme") ?? __COLLAB_THEME__) as "dark" | "light"
const at = "2026-09-13T08:00:00Z"
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
let nativeFrames = 0
let countingFrames = true
function countFrame() { if (countingFrames) { nativeFrames += 1; requestAnimationFrame(countFrame) } }
requestAnimationFrame(countFrame)
const native = () => (window as unknown as { webkit?: { messageHandlers: { bench: { postMessage: (text: string) => void } } } }).webkit?.messageHandlers.bench ?? { postMessage: (text: string) => {
  const target = window as unknown as { __collaborationResults?: unknown[] }
  ;(target.__collaborationResults ??= []).push(JSON.parse(text))
} }
let resizeObserverWarnings = 0
let checkTimeout: ReturnType<typeof setTimeout>
window.addEventListener("error", (event) => {
  if (event.message === "ResizeObserver loop completed with undelivered notifications.") {
    resizeObserverWarnings += 1
    return
  }
  native().postMessage(JSON.stringify({ fixture: "collaboration", pass: false, error: event.message }))
})
window.addEventListener("unhandledrejection", (event) => native().postMessage(JSON.stringify({ fixture: "collaboration", pass: false, error: String(event.reason) })))
const project: Project = { id: "project-1", name: "Kybern", path: "/project", is_git: true, worktrees_default: true, created_at: at, updated_at: at }
const thread = (id: string, title: string, kind: "codex" | "opencode"): Thread => ({ id, project_id: project.id, title, provider: { kind, instance: "default" }, model: null, effort: null, permission_mode: "full-access", status: "idle", cwd: "/project", worktree: null, provider_session_id: null, pinned: false, created_at: at, updated_at: at, last_seq: 0 })
const mainThread = { ...thread("thread-main", "Coordinate Phase 3", "opencode"), provider_session_id: "session-main" }
const threads = { "thread-main": mainThread, "thread-worker": thread("thread-worker", "Desktop implementer", "codex"), "thread-reviewer": thread("thread-reviewer", "OpenCode reviewer", "opencode"), "thread-standby": thread("thread-standby", "Standby verifier", "codex") }
const providers: ProviderStatus[] = [
  { kind: "codex", display_name: "Codex", available: true, supported_permission_modes: ["full-access"], supports_fork: true, supports_model_switch: true, instances: ["default"], models: [{ id: "gpt-6", display_name: "GPT-6", is_default: true }] },
  { kind: "opencode", display_name: "OpenCode", available: true, supported_permission_modes: ["full-access"], supports_fork: true, supports_model_switch: true, instances: ["team"], models: [{ id: "kimi-k2", display_name: "Kimi K2" }] },
  { kind: "claude-code", display_name: "Claude Code", available: false, unavailable_reason: "Not installed", supported_permission_modes: [], supports_fork: false, supports_model_switch: false, instances: [] },
]
function theme(variant: "dark" | "light") {
  const root = document.documentElement
  root.classList.toggle("dark", variant === "dark"); root.dataset.themeVariant = variant; root.dataset.runtime = "electron"; root.dataset.platform = "macos"
  const built = buildThemeCssVariables({ codeThemeId: DEFAULT_THEME_STATE.codeThemeIds[variant], theme: DEFAULT_THEME_STATE.chromeThemes[variant] }, variant, { electron: true, isMac: true, systemUiFont: true })
  for (const [key, value] of Object.entries(built.variables)) root.style.setProperty(key, value)
}
function write(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!; setter.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true }))
}
const visible = (element: HTMLElement) => element.getClientRects().length > 0 && !element.closest('[aria-hidden="true"], [inert]') && (!element.closest("details:not([open])") || !!element.closest("summary"))
const button = (text: string) => {
  const matches = Array.from(document.querySelectorAll<HTMLButtonElement>('button,[role="menuitem"],[role="menuitemradio"]')).filter((item) => visible(item) && (item.getAttribute("aria-label") === text || item.textContent?.trim() === text))
  return matches.find((item) => item.closest('[role="menu"]')) ?? matches.findLast((item) => item.closest('[role="dialog"]')) ?? matches[0]
}
let stage = "initial"
async function click(text: string) { stage = text; native().postMessage(JSON.stringify({stage: text})); const target = button(text); if (!target) { const available = Array.from(document.querySelectorAll<HTMLElement>('button,[role="menuitem"],[role="menuitemradio"]')).filter(visible).map((item) => item.getAttribute("aria-label") || item.textContent?.trim()).filter(Boolean); throw new Error(`Missing button: ${text}; visible=${available.slice(0, 60).join(" | ")}`) } target.scrollIntoView({ block: "nearest" }); target.click(); native().postMessage(JSON.stringify({stage: `clicked ${text}`})); await sleep(180); return target }
const activeDialog = (title: string) => Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).find((item) => visible(item) && item.textContent?.includes(title))
const field = <T extends HTMLInputElement | HTMLTextAreaElement>(label: string, selector: string) => Array.from(document.querySelectorAll<HTMLLabelElement>("label")).find((item) => visible(item) && item.querySelector("span")?.textContent?.trim() === label)?.querySelector<T>(selector)
async function menuAction(label: string) {
  await click("More agent actions")
  if (!button(label)) {
    await click("More agent actions")
  }
  await click(label)
}
async function choose(label: string, value: string) { await click(label); await click(value) }
async function escape() { document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await sleep(350) }
async function clickTab(view: "work" | "messages" | "context") { const target = document.querySelector<HTMLButtonElement>(`[role="tab"][data-view="${view}"]`); if (!target) throw new Error(`Missing tab: ${view}`); target.click(); await sleep(180) }

async function run() {
  checkTimeout = setTimeout(() => native().postMessage(JSON.stringify({ fixture: "collaboration", pass: false, error: "Interaction timed out", lastAction: stage, body: document.body.textContent?.slice(-3500) })), 45000)
  if (collaborationReplay) return runReplay()
  theme(captureTheme)
  useStore.getState().set({ projects: { [project.id]: project }, threads, providers, selected: { kind: "thread", id: "thread-main" } })
  flushSync(() => createRoot(document.getElementById("root")!).render(<main className="h-screen w-full bg-[var(--color-background-surface)]"><CollaborationPane threadId="thread-main" active /></main>))
  await sleep(500)
  const emptyHasNoSetup = Array.from(document.querySelectorAll<HTMLElement>('input,textarea,select')).filter(visible).length === 0 && document.body.textContent?.includes("No helper threads yet") === true && !!button("Return to chat")
  if (captureView === "manual" || captureView === "empty") return reportPreview("first-use", emptyHasNoSetup)
  await fixtureRpc().call("collaboration.groups.create", {
    operation_id: "fixture-existing-group",
    project_id: project.id,
    coordinator_thread_id: mainThread.id,
    objective: "Coordinate Phase 3",
    success_criteria: [],
    coordinator_mode: "ordinary",
  })
  refreshCollaborationFixture()
  await sleep(350)
  await click("Start agent")
  const firstStartDialog = activeDialog("Start agent")!
  const taskDraft = field<HTMLTextAreaElement>("Task", "textarea")!
  if (!taskDraft) throw new Error("Start agent task missing")
  const simpleStartFields = !!firstStartDialog.querySelector('[aria-label="Provider"]') && !Array.from(firstStartDialog.querySelectorAll<HTMLElement>("input")).some(visible)
  write(taskDraft, "Review the authentication changes and report any security issues.")
  if (captureView === "start") return reportPreview("start-agent", simpleStartFields)
  collaborationFixtureState.failNextAssignment = true
  await click("Start agent")
  await sleep(500)
  const firstFailurePreservesDialog = activeDialog("Start agent")?.querySelector("textarea") === taskDraft && taskDraft.value.includes("authentication") && (activeDialog("Start agent")?.textContent ?? "").includes("Couldn’t start the agent")
  await click("Start agent")
  await sleep(400)
  const firstRequests = collaborationFixtureState.assignmentRequests
  const firstStartRetryExact = collaborationFixtureState.groupCreates === 1 && firstRequests.length === 2 && JSON.stringify(firstRequests[0]) === JSON.stringify(firstRequests[1])
  const automaticSourceBase = (firstRequests[0]?.child as {base_revision?:string})?.base_revision === "refs/heads/worktrees/fixture"
  const defaultWorkHasNoEditableForms = Array.from(document.querySelectorAll<HTMLElement>('input,textarea,select')).filter(visible).length === 0
  const workTab = document.querySelector<HTMLButtonElement>('[role="tab"][data-view="work"]')!
  workTab.focus(); workTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); await sleep(80)
  const messagesTab = document.querySelector<HTMLButtonElement>('[role="tab"][data-view="messages"]')!
  const keyboardTabs = messagesTab.getAttribute("aria-selected") === "true" && document.activeElement === messagesTab
  const tabFocusStyle = getComputedStyle(messagesTab)
  const tabFocusVisible = tabFocusStyle.boxShadow !== "none" || (tabFocusStyle.outlineStyle !== "none" && Number.parseFloat(tabFocusStyle.outlineWidth) > 0)
  const tabFocusIndicatorDeclared = messagesTab.className.includes("focus-visible:ring")
  messagesTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); await sleep(80)

  const editObjectiveTrigger = button("More agent actions")!; editObjectiveTrigger.focus(); await menuAction("Edit objective")
  const editObjectiveDialog = activeDialog("Edit objective")
  const objectiveDialogLabels = !!editObjectiveDialog && Array.from(editObjectiveDialog.querySelectorAll("label")).some((item) => item.textContent?.includes("Objective")) && Array.from(editObjectiveDialog.querySelectorAll("label")).some((item) => item.textContent?.includes("Success criteria"))
  const objectiveDraft = editObjectiveDialog?.querySelector<HTMLTextAreaElement>("textarea")
  if (!objectiveDraft) throw new Error("Edit objective draft missing")
  write(objectiveDraft, "Local objective draft survives failures and refresh")
  collaborationFixtureState.failNextMutation = true
  await click("Save objective")
  const failedSaveKeptDraft = !!activeDialog("Edit objective") && objectiveDraft.value === "Local objective draft survives failures and refresh"
  refreshCollaborationFixture(); await sleep(300)
  const refreshKeptDraft = !!activeDialog("Edit objective") && objectiveDraft.value === "Local objective draft survives failures and refresh"
  refreshCollaborationFixture("Objective changed on the server"); await sleep(300)
  const remoteRefreshKeptDraft = !!activeDialog("Edit objective") && objectiveDraft.value === "Local objective draft survives failures and refresh"
  await click("Save objective")
  const casRejectedAndKeptDraft = !!activeDialog("Edit objective") && objectiveDraft.value === "Local objective draft survives failures and refresh" && (document.body.textContent ?? "").includes("Group changed. Reload it before saving.")
  await escape()
  const dialogEscapeClosed = !activeDialog("Edit objective")
  const dialogEscapeAndFocusReturn = dialogEscapeClosed && document.activeElement === editObjectiveTrigger
  const objectiveEscapeFocus = (document.activeElement as HTMLElement | null)?.getAttribute("aria-label") || (document.activeElement as HTMLElement | null)?.textContent?.trim() || document.activeElement?.tagName

  await menuAction("Limits and permissions")
  await click("Only coordinate helpers")
  await click("Save settings")
  const releasedForDedicatedChange = collaborationFixtureState.releases === 1
  useStore.getState().set({ threads: { ...useStore.getState().threads, "thread-main": { ...mainThread, provider: { kind: "codex", instance: "default" }, provider_session_id: null } } })
  await sleep(80)
  await menuAction("Limits and permissions")
  const settingsDialog = activeDialog("Limits and permissions")
  const settingsLabelsVisible = !!settingsDialog?.querySelector('[aria-label="Active workers"]') && !!settingsDialog.querySelector('[aria-label="Delegation depth"]') && (settingsDialog.textContent ?? "").includes("Codex") && (settingsDialog.textContent ?? "").includes("OpenCode")
  const settingsFit = !!settingsDialog && settingsDialog.scrollWidth <= settingsDialog.clientWidth + 1
  const unsupportedDedicated = !!button("Only coordinate helpers")?.disabled
  await click("Can work and start helpers")
  await click("OpenCode")
  await choose("Active workers", "2")
  await click("Save settings")
  useStore.getState().set({ threads: { ...useStore.getState().threads, "thread-main": { ...useStore.getState().threads["thread-main"]!, provider_session_id: "same-mode-session" } } })
  await sleep(80)
  await menuAction("Limits and permissions")
  await choose("Active workers", "32")
  await click("Save settings")
  const policyUpdated = collaborationFixtureState.releases === 2

  await menuAction("Manage agents")
  const participantsDialog = activeDialog("Manage agents")
  const participantLabelsVisible = !!participantsDialog?.querySelector('[aria-label="Thread to attach"]') && !!participantsDialog.querySelector('[aria-label="Participant role"]')
  await escape()

  await click("Start agent")
  const assignmentDialog = activeDialog("Start agent")
  const assignmentLabelsVisible = !!assignmentDialog && ["Task"].every((label) => Array.from(assignmentDialog.querySelectorAll("label")).some((item) => item.textContent?.includes(label)))
  await click("Provider")
  const agentMenuText = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')).filter(visible).map((item) => item.textContent?.trim())
  const unavailableHidden = !agentMenuText.some((item) => item?.includes("Claude"))
  await click("Codex")
  await click("Model")
  const modelVisible = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')).filter(visible).some((item) => item.textContent?.includes("GPT-6"))
  await click("GPT-6")
  const assignmentTask = field<HTMLTextAreaElement>("Task", "textarea")!; write(assignmentTask, "Check transport contract")
  await click("Start agent")
  const secondStartIsNew = collaborationFixtureState.assignmentRequests.length === 3 && collaborationFixtureState.assignmentRequests[2].operation_id !== firstRequests[0].operation_id

  await click("Message")
  const directMessageNavigatesThread = useStore.getState().selected.kind === "thread" && (useStore.getState().selected as {id:string}).id === "thread-worker" && !collaborationFixtureState.progressRequestValid
  useStore.getState().set({ selected: { kind: "thread", id: "thread-main" } })
  await clickTab("messages")
  const messageDisclosure = button("Show full message from Desktop implementer")
  if (!messageDisclosure) throw new Error("Long message disclosure missing")
  const messagePreview = messageDisclosure.closest("article")?.querySelector<HTMLElement>("[data-message-preview]")
  const messagePreviewStyle = messagePreview ? getComputedStyle(messagePreview) : null
  const messagePreviewLineHeight = messagePreviewStyle ? (Number.parseFloat(messagePreviewStyle.lineHeight) || Number.parseFloat(messagePreviewStyle.fontSize) * 1.2) : 0
  const collapsedMessageClamped = !!messagePreview && messagePreview.getBoundingClientRect().height <= messagePreviewLineHeight * 3.2 + 1
  messageDisclosure.click(); await sleep(120)
  const fullMessageReachable = (messageDisclosure.closest("article")?.textContent ?? "").includes("END-OF-FULL-MESSAGE")
  await click("Save note")
  const messageDialog = activeDialog("Save progress note")
  const messageLabelsVisible = !!messageDialog?.querySelector('[aria-label="Note recipient"]') && Array.from(messageDialog.querySelectorAll("label")).some((item) => item.textContent?.includes("Note"))
  const progress = field<HTMLTextAreaElement>("Note", "textarea")!; write(progress, "Fixture transport request is valid.")
  await click("Save note")
  const transportRequestsValid = collaborationFixtureState.childBaseValid && collaborationFixtureState.progressRequestValid
  await click("Load earlier messages")
  const messagesPagedText = document.body.textContent ?? ""
  const publicProgressAttributed = messagesPagedText.includes("You") && messagesPagedText.includes("to") && messagesPagedText.includes("Desktop implementer") && messagesPagedText.includes("Fixture transport request is valid.")

  await clickTab("context")
  await click("Load earlier notes")
  const contextArticle = Array.from(document.querySelectorAll<HTMLElement>("article")).find((item) => item.textContent?.includes("release-checks"))
  const contextDisclosure = contextArticle?.querySelector<HTMLButtonElement>("button")
  if (!contextDisclosure) throw new Error("Context disclosure missing")
  collaborationFixtureState.failNextHistory = true
  contextDisclosure.click(); await sleep(180)
  const historyAlert = contextArticle.querySelector<HTMLElement>('[role="alert"]')
  const historyFailureKeepsCurrentBody = contextDisclosure.getAttribute("aria-expanded") === "true" && (contextArticle.textContent ?? "").includes("Current revision 3") && (contextArticle.textContent ?? "").includes("Run desktop and mobile checks before handoff.")
  const actionableHistoryError = !!historyAlert && (historyAlert.textContent ?? "").includes("Couldn’t load revision history. Try again.") && (historyAlert.textContent ?? "").includes("History service unavailable.")
  contextDisclosure.click(); await sleep(80); contextDisclosure.click(); await sleep(180)
  const historyRetrySucceeded = !contextArticle.querySelector('[role="alert"]') && (contextArticle.textContent ?? "").includes("Revision 2") && !!button("Load earlier revisions")
  await click("Load earlier revisions")
  const addContextTrigger = button("Add note")!
  addContextTrigger.focus()
  await click("Add note")
  const contextDialog = activeDialog("Add shared note")
  const contextLabelsVisible = !!contextDialog && ["Name", "Content"].every((label) => Array.from(contextDialog.querySelectorAll("label")).some((item) => item.textContent?.includes(label)))
  await escape()
  const contextEscapeClosed = !activeDialog("Add shared note")
  const contextEscapeFocusReturn = contextEscapeClosed && document.activeElement === addContextTrigger
  const contextEscapeFocus = (document.activeElement as HTMLElement | null)?.getAttribute("aria-label") || (document.activeElement as HTMLElement | null)?.textContent?.trim() || document.activeElement?.tagName
  const contextPagedText = document.body.textContent ?? ""
  const resultReferenceArticle = Array.from(document.querySelectorAll<HTMLElement>("article")).find((item) => item.textContent?.includes("learned-test-command"))
  const resultReferenceDisclosure = resultReferenceArticle?.querySelector<HTMLButtonElement>("button")
  if (!resultReferenceArticle || !resultReferenceDisclosure) throw new Error("Coordinator result reference missing")
  resultReferenceDisclosure.click(); await sleep(180)
  const correctResultReference = Array.from(resultReferenceArticle.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.includes("Correct note"))
  if (!correctResultReference) throw new Error("Coordinator result reference correction missing")
  correctResultReference.click(); await sleep(180)
  const correctionDialog = activeDialog("Correct shared note")
  const correctionExplainsAuthority = !!correctionDialog?.textContent?.includes("authoritative revision")
  await click("Save note")
  const resultReferenceCorrection = collaborationFixtureState.contextRequests.some((request) => request.entry_id === "context-result-reference" && request.expected_revision === 2 && request.kind === "result_reference" && request.user_authored === true)

  await clickTab("work")
  const workHeading = Array.from(document.querySelectorAll("h3")).find((item) => item.textContent?.trim() === "Work")
  const workDetail = workHeading?.parentElement?.textContent ?? ""
  const workCountsSeparateAttention = workDetail.includes("1 queued · 1 working · 2 need attention") && !workDetail.includes("4 active tasks")
  const collaborationHeader = document.querySelector("[data-collaboration-view] header")?.textContent ?? ""
  const headerCountsOnlyActiveWork = collaborationHeader.includes("2 active") && !collaborationHeader.includes("4 active")
  const attentionTasksRemainVisible = !!button("Show details for Resolve helper question") && !!button("Show details for Wait for dependency")
  const failedTaskRemainsVisible = !!button("Show details for Run unavailable check")
  const resultDisclosure = button("Show details for Review integration")
  if (!resultDisclosure) throw new Error("Review integration disclosure missing")
  const collapsedSummary = resultDisclosure.closest("article")?.querySelector<HTMLElement>('[data-assignment-summary], .line-clamp-2')
  const collapsedStyle = collapsedSummary ? getComputedStyle(collapsedSummary) : null
  const collapsedLineHeight = collapsedStyle ? (Number.parseFloat(collapsedStyle.lineHeight) || Number.parseFloat(collapsedStyle.fontSize) * 1.2) : 0
  const collapsedResultClamped = !!collapsedSummary && collapsedSummary.getBoundingClientRect().height <= collapsedLineHeight * 2.2 + 1
  resultDisclosure.click(); await sleep(120)
  const expandedResult = resultDisclosure.closest("article")?.textContent ?? ""
  const resultDetailsAccessible = ["END-OF-FULL-RESULT", "Changes", "apps/desktop/src/views/Collaboration.tsx", "Checks", "Desktop collaboration fixture", "Artifacts", "artifacts/collaboration-redesign/desktop-work.png", "Unresolved", "Physical device reconnect"].every((value) => expandedResult.includes(value))
  await click("Load earlier tasks")
  const workPagedText = document.body.textContent ?? ""
  const pagingReachedOlder = workPagedText.includes("Research coordination") && messagesPagedText.includes("Initial investigation finished") && contextPagedText.includes("webkit-finding") && contextPagedText.includes("learned-test-command") && contextPagedText.includes("Revision 1")
  const dialogLabelsVisible = objectiveDialogLabels && settingsLabelsVisible && participantLabelsVisible && assignmentLabelsVisible && messageLabelsVisible && contextLabelsVisible

  const discoveryBeforeMetadata = collaborationFixtureState.discoveryCalls
  emitThreadMetadataUpdates(useStore.getState().threads["thread-worker"]!, 20)
  await sleep(220)
  const metadataUpdatesAvoidDiscovery = collaborationFixtureState.discoveryCalls === discoveryBeforeMetadata

  const historyDisclosure = Array.from(document.querySelectorAll<HTMLElement>("summary")).find((item) => item.textContent?.trim() === "Previous agents")
  if (!historyDisclosure) throw new Error("Previous agents disclosure missing")
  historyDisclosure.click(); await sleep(100)
  await click("View")
  await clickTab("messages")
  refreshCollaborationFixture(); await sleep(300)
  const historySelectionSurvivesRefresh = !!button("Return to current agents") && collaborationFixtureState.lastMessageGroup === "group-previous"
  await click("Return to current agents")
  await clickTab("work")
  await menuAction("Pause agents")
  await sleep(500)
  await click("More agent actions")
  const paused = !!button("Resume agents")
  await click("Resume agents"); await sleep(500); await menuAction("Stop agents"); await sleep(500)
  await click("More agent actions")
  const stopped = !!button("Resume agents") && !button("Stop agents")
  await escape()
  const text = document.body.textContent ?? ""
  const functionalScroller = document.querySelector<HTMLElement>('[data-collaboration-view]')
  const horizontalOverflow = Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, (functionalScroller?.scrollWidth ?? 0) - (functionalScroller?.clientWidth ?? 0))
  theme("light"); await sleep(80); const lightReadable = getComputedStyle(document.body).color !== "rgba(0, 0, 0, 0)"
  theme(captureTheme); await sleep(80)
  if (captureTheme === "dark") {
    const scroller = document.querySelector<HTMLElement>(".overflow-y-auto")
    scroller?.scrollTo({ top: scroller.scrollHeight })
    await sleep(80)
  }
  const pass = historySelectionSurvivesRefresh && settingsFit && emptyHasNoSetup && simpleStartFields && firstFailurePreservesDialog && firstStartRetryExact && secondStartIsNew && directMessageNavigatesThread && defaultWorkHasNoEditableForms && keyboardTabs && tabFocusIndicatorDeclared && dialogLabelsVisible && failedSaveKeptDraft && refreshKeptDraft && remoteRefreshKeptDraft && casRejectedAndKeptDraft && dialogEscapeAndFocusReturn && contextEscapeFocusReturn && correctionExplainsAuthority && resultReferenceCorrection && unavailableHidden && modelVisible && releasedForDedicatedChange && unsupportedDedicated && policyUpdated && automaticSourceBase && transportRequestsValid && collapsedMessageClamped && fullMessageReachable && publicProgressAttributed && historyFailureKeepsCurrentBody && actionableHistoryError && historyRetrySucceeded && collapsedResultClamped && resultDetailsAccessible && metadataUpdatesAvoidDiscovery && paused && stopped && horizontalOverflow <= 1 && lightReadable && pagingReachedOlder && workCountsSeparateAttention && headerCountsOnlyActiveWork && attentionTasksRemainVisible && failedTaskRemainsVisible && text.includes("Needs review") && text.includes("Lifecycle works")
  clearTimeout(checkTimeout)
  countingFrames = false
  native().postMessage(JSON.stringify({ fixture: "collaboration", resizeObserverWarnings, pass, historySelectionSurvivesRefresh, settingsFit, emptyHasNoSetup, simpleStartFields, firstFailurePreservesDialog, firstStartRetryExact, secondStartIsNew, directMessageNavigatesThread, defaultWorkHasNoEditableForms, keyboardTabs, tabFocusIndicatorDeclared, tabFocusVisibleUnderSyntheticEvent: tabFocusVisible, dialogLabelsVisible, failedSaveKeptDraft, refreshKeptDraft, remoteRefreshKeptDraft, casRejectedAndKeptDraft, dialogEscapeClosed, dialogEscapeAndFocusReturn, objectiveEscapeFocus, contextEscapeClosed, contextEscapeFocusReturn, contextEscapeFocus, correctionExplainsAuthority, resultReferenceCorrection, unavailableHidden, modelVisible, releasedForDedicatedChange, unsupportedDedicated, policyUpdated, automaticSourceBase, transportRequestsValid, collapsedMessageClamped, fullMessageReachable, publicProgressAttributed, historyFailureKeepsCurrentBody, actionableHistoryError, historyRetrySucceeded, collapsedResultClamped, resultDetailsAccessible, metadataUpdatesAvoidDiscovery, workCountsSeparateAttention, headerCountsOnlyActiveWork, attentionTasksRemainVisible, failedTaskRemainsVisible, paused, stopped, pagingReachedOlder, horizontalOverflow, lightReadable, width: innerWidth, finalTheme: captureTheme, assignmentCards: document.querySelectorAll("article").length, historyRevisions: contextPagedText.match(/Revision \d/g)?.length ?? 0 }))
}

async function reportPreview(scenario: string, valid: boolean) {
  theme(captureTheme)
  await sleep(500)
  const horizontalOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth
  clearTimeout(checkTimeout)
  countingFrames = false
  native().postMessage(JSON.stringify({ fixture: "collaboration", scenario, pass: valid && horizontalOverflow <= 1 && (scenario !== "start-agent" || Number(getComputedStyle(activeDialog("Start agent")!).opacity) >= 0.99), nativeFrames, visibility: document.visibilityState, dialogs: Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).map((el) => ({text:el.textContent, opacity:getComputedStyle(el).opacity, open:el.getAttribute("data-open"), rect:el.getBoundingClientRect().toJSON()})), horizontalOverflow, width: innerWidth, theme: captureTheme }))
}

async function runReplay() {
  const data = collaborationReplay!
  theme(captureTheme)
  if (__COLLAB_STRESS__ === "rtl") document.documentElement.dir = "rtl"
  if (__COLLAB_STRESS__ === "zoom") document.documentElement.style.zoom = "2"
  useStore.getState().set({ projects: { [data.project.id]: data.project }, threads: data.threads, providers: data.providers, selected: { kind: "thread", id: data.detail.group.coordinator_thread_id } })
  flushSync(() => createRoot(document.getElementById("root")!).render(<main className="h-screen w-full bg-[var(--color-background-surface)]"><CollaborationPane threadId={data.detail.group.coordinator_thread_id} active /></main>))
  await sleep(500)
  const tab = captureView === "messages" ? "messages" : captureView.startsWith("context") ? "context" : "work"
  const tabButton = document.querySelector<HTMLButtonElement>(`[role="tab"][data-view="${tab}"]`)
  if (!tabButton && captureView !== "baseline") throw new Error(`Missing view: ${tab}`)
  tabButton?.click()
  await sleep(180)
  if (captureView === "context-history") {
    const contextDisclosure = Array.from(document.querySelectorAll<HTMLElement>("article")).find(visible)?.querySelector<HTMLButtonElement>("button")
    if (!contextDisclosure) throw new Error("Missing context history disclosure")
    contextDisclosure.click()
  }
  await sleep(200)
  const text = document.body.textContent ?? ""
  const selectedTab = document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.dataset.view
  const firstAssignment = Array.from(document.querySelectorAll<HTMLElement>("article")).find(visible)
  const visibleEditableCount = Array.from(document.querySelectorAll<HTMLElement>('input,textarea,select')).filter(visible).length
  const collaborationScroller = document.querySelector<HTMLElement>('[data-collaboration-view]') ?? Array.from(document.querySelectorAll<HTMLElement>("*")).filter((element) => visible(element) && element.scrollHeight > element.clientHeight).sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
  const horizontalOverflow = Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, (collaborationScroller?.scrollWidth ?? 0) - (collaborationScroller?.clientWidth ?? 0))
  const objectiveVisibleWhenExpected = captureView === "baseline" ? text.includes(data.detail.group.objective) : text.includes("Agents")
  const pass = horizontalOverflow <= 1 && objectiveVisibleWhenExpected && (captureView === "baseline" ? !tabButton : selectedTab === tab)
  clearTimeout(checkTimeout)
  countingFrames = false
  native().postMessage(JSON.stringify({ fixture: "collaboration", scenario: "saved-live-run", pass, view: captureView, theme: captureTheme, stress: __COLLAB_STRESS__, width: innerWidth, horizontalOverflow, visibleEditableCount, firstAssignmentTop: firstAssignment?.getBoundingClientRect().top ?? null, mountedElements: document.querySelectorAll("*").length, scrollHeight: collaborationScroller?.scrollHeight ?? document.documentElement.scrollHeight }))
}
run().catch((error) => native().postMessage(JSON.stringify({ fixture: "collaboration", pass: false, error: String(error) })))
