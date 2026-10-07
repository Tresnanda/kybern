import { useNow } from "@/lib/hooks"
import { AccountPicker } from "@/components/kybern/AccountPicker"
import type { ThreadTargetState, SessionTarget, ProviderStatus } from "@/protocol"
import { offerWorktreeCleanup } from "@/state/worktreeCleanup"
import { collaborationPreview } from "../../../../packages/kybern-client/src/collaboration"
import { promptText, replacePromptText } from "../../../../packages/kybern-client/src/prompts"
import { DeleteCoordinatorDialog } from "./DeleteCoordinatorDialog"
import { Textarea } from "@/components/kit/textarea"
import { observeResizeFrame } from "@/lib/resizeObserver"
import { AsyncQuestionPanel } from "./AsyncQuestionPanel"
import { Markdown } from "@/components/kybern/Markdown"
import { computerConsent, connectorApproval, connectorApprovalResponse, isUserInput, notesTasksConsent, type ConnectorApproval, type NotesTasksConsent } from "@/lib/userInput"
import { splitChecklistPreview } from "@/lib/agentItemTools"
import { UserInputPanel } from "./UserInputPanel"
import { TextSwap } from "@/components/kybern/motion"
// Thread route: Header (provider glyph, title, Hand off,
// actions, dock toggle), the transcript scrolling under the frosted composer,
// queued follow-ups stacked above the input and the approval card.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useHotkey } from "@/lib/hooks"
import { toast } from "sonner"

import { ProviderMark } from "@/components/kybern/bits"
import { Button } from "@/components/kit/button"
import { DisclosureChevron } from "@/components/kit/DisclosureChevron"
import { DisclosureRegion } from "@/components/kit/DisclosureRegion"
import { IconButton } from "@/components/kit/icon-button"
import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { ComposerPanelStack, ComposerStackedPanel, COMPOSER_STACKED_PANEL_DIVIDER_CLASS_NAME } from "@/components/kit/chat/ComposerStackedPanel"
import { ComposerStackedPanelRow, ComposerStackedPanelRowMain } from "@/components/kit/chat/ComposerStackedPanelContent"
import { Menu, MenuGroup, MenuItem, MenuSeparator, MenuShortcut, MenuTrigger } from "@/components/kit/menu"
import { PROVIDER_LABEL, basename, mod, toolLine } from "@/lib/format"
import { promptCacheWindow } from "@/lib/promptCache"
import { activeTaskSummary } from "@/lib/runtimeActivity"
import {
  AnalyticsIcon,
  ArrowLeftIcon,
  ArchiveIcon,
  BackToParentIcon,
  ChangesIcon,
  ClockIcon,
  ComputerTerminalIcon,
  EllipsisIcon,
  FoldersIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  HandoffIcon,
  Maximize2,
  NewThreadIcon,
  PaperclipIcon,
  PencilIcon,
  PinFilledIcon,
  PinIcon,
  RobotIcon,
  SettingsIcon,
  SteerIcon,
  StopIcon,
  SquareSplitHorizontal,
  SquareSplitVertical,
  TerminalIcon,
  Trash2,
  WorkflowIcon,
  UsersIcon,
  XIcon,
  DeviceLaptopIcon,
  ListChecksIcon,
  NoteIcon,
} from "@/lib/kit/icons"
import { ComputerLiveView } from "./ComputerLiveView"
import { COMPOSER_STACKED_PANEL_ICON_CLASS_NAME, COMPOSER_STACKED_PANEL_PREVIEW_MARKDOWN_CLASS_NAME } from "@/components/kit/chat/composerStackedPanelStyles"
import { openExternal } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import { isFreeChatProject, type ApprovalRequest, type JsonValue, type RuntimeTask, type ThreadId, type UserMessage } from "@/protocol"
import { newThread } from "@/state/nav"
import { activeRuntime, subscribeCollaboration, archiveThread, errorText, interrupt, loadThread, respondApproval, rpc, sendMessage, queueMessage, removeQueuedMessage, updateThread } from "@/state/rpc"
import { canSplitPane, type PaneId } from "@/state/splitView"
import { isRuntimeTaskActive, useStore } from "@/state/store"
import { windowHoldsTranscript } from "@/state/windowSurfaceState"

import { ENVIRONMENT_CONTENT_INSET_MOTION_CLASS } from "@/components/kit/chat/composerPickerStyles"

import { Composer, type ComposerHandle, type SlashCommand } from "./Composer"
import { ENVIRONMENT_DOCKED_CONTENT_INSET_PX, EnvironmentPanel } from "./Environment"
import { Transcript } from "./Transcript"
import { SubagentStrip } from "./subagents/SubagentStrip"
import { HeldMessagesPanel } from "./delegations/HeldMessagesPanel"
import { structuredMessageBody, structuredMessageSummary } from "../../../../packages/kybern-client/src/delegations.ts"
import { SubagentBar, SubagentBreadcrumb } from "./subagents/SubagentPage"
import { openParentOf, openParentShortcut, stopOneSubagent, useAncestors, useHelperThreads, useSubagentDepth } from "@/state/subagents"
import { pageDirection, playPageMotion, lastInputWasPointer } from "@/lib/navMotion"
import { subagentPhase } from "../../../../packages/kybern-client/src/subagents.ts"
import { CHAT_COLUMN_GUTTER, CHAT_COLUMN_GUTTER_PX } from "./chatLayout"
import { ChatHeaderButton, ChatHeaderIconButton, SurfaceHeader } from "./chrome"

const EMPTY: never[] = []
const EMPTY_TASKS: RuntimeTask[] = []


/** MCP approvals carry the server name in their input; other tools fall back to the tool name. */
function approvalServerName(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null
  const name = (input as Record<string, unknown>).serverName
  return typeof name === "string" ? name : null
}

export function ThreadView({
  threadId,
  splitPaneId,
  isFocused = true,
}: {
  threadId: ThreadId
  splitPaneId?: PaneId
  isFocused?: boolean
}) {
  const steeringAttempt = useRef<{ signature: string; id: string } | null>(null)
  const coordinatorSwitchAttempt = useRef<{ fingerprint: string; operationId: string } | null>(null)
  const thread = useStore((s) => s.threads[threadId])
  const coordinatorProjectName = useStore((s) =>
    thread?.coordinator_project_id ? s.projects[thread.project_id]?.name : undefined
  )
  const providerUsage = useStore((s) => s.transcripts[threadId]?.providerUsage)
  const promptCacheActivityAt = useStore((s) => {
    const blocks = s.transcripts[threadId]?.blocks
    if (!blocks) return undefined
    for (let index = blocks.length - 1; index >= 0; index--) {
      const block = blocks[index]
      if (block?.kind === "turn_end") return block.at
    }
    return undefined
  })
  const settings = useStore((s) => s.settings)
  const loaded = useStore((s) => s.transcripts[threadId]?.loaded)
  const questions = useStore((s) => s.transcripts[threadId]?.pendingQuestions ?? EMPTY)
  const pending = useStore((s) => s.transcripts[threadId]?.pendingApprovals ?? EMPTY)
  const queued = useStore((s) => s.queued[threadId] ?? EMPTY)
  const runtimeTasks = useStore((s) => s.runtimeTasks[threadId] ?? EMPTY_TASKS)
  const activeTasks = useMemo(() => runtimeTasks.filter(isRuntimeTaskActive), [runtimeTasks])
  // Agents get the subagent strip; processes and monitors keep the generic activity panel.
  const activeAgentTasks = useMemo(() => activeTasks.filter((task) => task.kind === "agent"), [activeTasks])
  const otherActiveTasks = useMemo(() => activeTasks.filter((task) => task.kind !== "agent"), [activeTasks])
  const latestTurnId = useStore((s) => s.transcripts[threadId]?.blocks.at(-1)?.turnId ?? null)
  const helperThreads = useHelperThreads(threadId)
  const subagentDepth = useSubagentDepth(threadId)
  const providers = useStore((s) => s.providers)
  const set = useStore((s) => s.set)
  const requestedEnvOpen = useStore((s) => s.envOpen)
  const envOpen = requestedEnvOpen && isFocused
  const composer = useRef<ComposerHandle>(null)
  const overlay = useRef<HTMLDivElement>(null)
  const page = useRef<HTMLDivElement>(null)
  const previousDepth = useRef<{ id: ThreadId; depth: number } | null>(null)
  const [overlayHeight, setOverlayHeight] = useState(120)
  const [nextTarget, setNextTarget] = useState<{ threadId: string; state: ThreadTargetState } | null>(null)
  const [accountCatalog, setAccountCatalog] = useState<{ key: string; status: ProviderStatus } | null>(null)
  const hasThread = !!thread
  const readOnlyThread = !!thread?.subagent
  useEffect(() => {
    if (!hasThread || readOnlyThread) return
    let canceled = false
    void rpc().call("threads.target.get", { thread_id: threadId }).then((state) => {
      if (!canceled) setNextTarget({ threadId, state })
    }).catch((error) => { if (!canceled) toast.error("Unable to load account selection", { description: errorText(error) }) })
    return () => { canceled = true }
  }, [threadId, thread?.status, thread?.provider.instance, thread?.model, settings, hasThread, readOnlyThread])
  const targetState = nextTarget?.threadId === threadId ? nextTarget.state : null
  const target = targetState?.target ?? (thread ? { provider: thread.provider, model: thread.model, effort: thread.effort } : null)
  const catalogKey = target ? `${threadId}:${target.provider.kind}:${target.provider.instance}` : ""
  const targetKind = target?.provider.kind
  const targetInstance = target?.provider.instance
  const targetProjectId = thread?.project_id
  useEffect(() => {
    if (!targetKind || !targetInstance || !targetProjectId || readOnlyThread) return
    let canceled = false
    void rpc().call("providers.accounts.catalog", { provider: { kind: targetKind, instance: targetInstance }, project_id: targetProjectId }).then((status) => {
      if (!canceled) setAccountCatalog({ key: catalogKey, status })
    }).catch((error) => { if (!canceled) toast.error("Unable to load account models", { description: errorText(error) }) })
    return () => { canceled = true }
  }, [catalogKey, targetKind, targetInstance, targetProjectId, readOnlyThread])
  const composerProviders = useMemo(() => providers.map((status) => status.kind !== targetKind ? status : accountCatalog?.key === catalogKey ? accountCatalog.status : { ...status, models: [] }), [providers, targetKind, accountCatalog, catalogKey])
  const chooseTarget = async (selection: SessionTarget, inherit = !targetState?.account_override) => {
    const state = await rpc().call("threads.target.set", { thread_id: threadId, target: selection, inherit_account: inherit })
    setNextTarget({ threadId, state })
  }
  const changePermission = async (mode: import("@/protocol").PermissionMode) => {
    await updateThread(threadId, { permission_mode: mode })
    const state = await rpc().call("threads.target.get", { thread_id: threadId })
    setNextTarget({ threadId, state })
  }


  useEffect(() => {
    if (!loaded && windowHoldsTranscript()) void loadThread(threadId)
  }, [threadId, loaded])

  useEffect(() => {
    if (isFocused) composer.current?.focus()
  }, [threadId, isFocused])

  // Opening a subagent pushes the page in; going back to its parent reverses it. Keyboard
  // navigation swaps instantly (see lib/navMotion.ts).
  useLayoutEffect(() => {
    const previous = previousDepth.current
    previousDepth.current = { id: threadId, depth: subagentDepth }
    if (!previous || previous.id === threadId || !page.current || !lastInputWasPointer()) return
    const direction = pageDirection(previous.depth, subagentDepth)
    if (direction) playPageMotion(page.current, direction)
  }, [threadId, subagentDepth])

  const settingsOpen = useStore((s) => s.settingsOpen)
  // ⌘↑: Open parent, as in Finder. Back (⌘[) stays pure history.
  useHotkey("mod+arrowup", () => void openParentShortcut(threadId), { allowInInput: true, enabled: isFocused && subagentDepth > 0 && !settingsOpen })

  // The composer floats over the transcript; keep the scroll inset in sync with its height.
  useLayoutEffect(() => {
    const el = overlay.current
    if (!el) return
    return observeResizeFrame(el, ([entry]) => {
      const height = Math.round(entry?.contentRect.height ?? 0)
      setOverlayHeight((current) => current === height ? current : height)
    })
  }, [])

  const running = thread?.status === "running" || thread?.status === "awaiting-approval"
  const canSwitchCoordinator = !!thread?.coordinator_project_id && (thread.status === "idle" || thread.status === "failed")
  const approval = pending[0] ?? null
  const connector = approval ? connectorApproval(approval) : null
  // A subagent thread is read-only; the subagent page replaces the composer with its own bar.
  const hideInput = (!!approval && isUserInput(approval) && !connector) || !!thread?.subagent

  const answer = (n: number): boolean => {
    if (!approval || (isUserInput(approval) && !connector) || (approval.tool_name === "ExitPlanMode" && n === 2)) return false
    const decision = connector
      ? n === 1
        ? ({ decision: "submit", response: connectorApprovalResponse(connector.persist.includes("session") ? "session" : null) } as const)
        : n === 2
          ? ({ decision: "submit", response: connectorApprovalResponse(null) } as const)
          : n === 3
            ? ({ decision: "deny" } as const)
            : null
      : n === 1 ? ({ decision: "allow_once" } as const) : n === 2 ? ({ decision: "allow_always" } as const) : n === 3 ? ({ decision: "deny" } as const) : null
    if (!decision) {
      if (n === 4) void interrupt(threadId)
      return n === 4
    }
    respondApproval(approval.id, decision).catch((e) => toast.error("Unable to respond", { description: errorText(e) }))
    return true
  }

  useEffect(() => {
    if (!isFocused) return
    const onKey = (e: KeyboardEvent) => {
      if (useStore.getState().settingsOpen) return
      if (!["1", "2", "3", "4"].includes(e.key) || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return
      if (answer(Number(e.key))) e.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approval?.id, isFocused])

  const nativeCommands = useStore((s) => s.transcripts[threadId]?.providerCommands ?? EMPTY)
  const freeChat = !!thread && isFreeChatProject(thread.project_id)
  const canCompact = !!thread?.provider_session_id && (
    ["codex", "pi", "omp", "opencode"].includes(thread.provider.kind) || nativeCommands.some((command) => command.name === "compact")
  )
  const commands = useMemo<SlashCommand[]>(
    () => [
      { name: "resume", hint: "Continue a saved session", icon: <ClockIcon className="size-4" />, run: () => set({ sessionsOpen: true, sessionsProjectId: freeChat ? null : thread?.project_id ?? null }) },
      { name: "sessions", hint: "Browse saved sessions", icon: <ClockIcon className="size-4" />, run: () => set({ sessionsOpen: true, sessionsProjectId: freeChat ? null : thread?.project_id ?? null }) },
      ...(canCompact ? [{ name: "compact", hint: "Compact context and keep conversation history", icon: <WorkflowIcon className="size-4" />, run: () => {
        void rpc().call("threads.compact", { thread_id: threadId }).catch((error) => toast.error("Unable to compact context", { description: errorText(error) }))
      } }] : []),
      ...nativeCommands.filter((command) => command.name !== "compact").map((command) => ({
        name: ["resume", "sessions", "new", "stop", "activity", "attach", "changes", "terminal", "files", "environment", "pr", "archive", "settings", "usage"].includes(command.name) ? `harness:${command.name}` : command.name,
        invocation: command.name,
        hint: `${PROVIDER_LABEL[thread?.provider.kind ?? "codex"]} · ${command.description}`,
        insert: true, run: () => {},
      })),
      { name: "new", hint: freeChat ? "Start a new free chat" : "Start a new thread in this project", icon: <NewThreadIcon className="size-4" />, run: () => newThread(freeChat ? undefined : thread?.project_id) },
      { name: "reconnect", hint: "Release the idle agent; resume history on your next message", icon: <WorkflowIcon className="size-4" />, run: () => {
        void rpc().call("threads.release", { thread_id: threadId }).then(() => toast("Agent released", { description: "Your next message resumes the saved conversation." })).catch((error) => toast.error("Unable to release agent", { description: errorText(error) }))
      } },
      { name: "stop", hint: "Interrupt the running turn", icon: <StopIcon className="size-4" />, run: () => void interrupt(threadId) },
      { name: "activity", hint: "Show agents and background processes", icon: <WorkflowIcon className="size-4" />, run: () => set({ rightOpen: true, rightTab: "activity" }) },
      { name: "agents", hint: "Start and coordinate helper agents", icon: <UsersIcon className="size-4" />, run: () => set({ rightOpen: true, rightTab: "collaboration" }) },
      { name: "collaboration", hint: "Open Agents", icon: <UsersIcon className="size-4" />, run: () => set({ rightOpen: true, rightTab: "collaboration" }) },
      { name: "attach", hint: "Attach files or images", icon: <PaperclipIcon className="size-4" />, run: () => document.querySelector<HTMLInputElement>('input[type="file"]')?.click() },
      { name: "terminal", hint: "Open a terminal in this thread", icon: <TerminalIcon className="size-4" />, run: () => set({ rightOpen: true, rightTab: "terminal" }) },
      ...(!freeChat ? [
        { name: "changes", hint: "Show the changes panel", icon: <ChangesIcon className="size-4" />, run: () => set({ rightOpen: true, rightTab: "changes" as const }) },
        { name: "files", hint: "Browse the project files", icon: <FoldersIcon className="size-4" />, run: () => set({ rightOpen: true, rightTab: "explorer" as const }) },
        { name: "environment", hint: "Show branch, commit and pull request controls", icon: <GitBranchIcon className="size-4" />, run: () => set({ rightOpen: true, rightTab: "changes" as const }) },
        {
        name: "pr",
        hint: "Create a pull request from this thread",
        icon: <GitPullRequestIcon className="size-4" />,
        run: () =>
          rpc()
            .call("github.pr.create", { thread_id: threadId })
            .then((p) => toast("Pull request opened", { description: p.title, action: { label: "Open", onClick: () => void openExternal(p.url) } }))
            .catch((e) => toast.error("Unable to create pull request", { description: errorText(e) })),
        },
      ] : []),
      ...(!thread?.coordinator_project_id ? [{ name: "archive", hint: "Archive this thread", icon: <ArchiveIcon className="size-4" />, run: () => void archiveThread(threadId) }] : []),
      { name: "settings", hint: "Open settings", icon: <SettingsIcon className="size-4" />, run: () => set({ settingsOpen: true, settingsTab: "general" }) },
      { name: "usage", hint: "Review token usage and cost", icon: <AnalyticsIcon className="size-4" />, run: () => useStore.getState().selectUsage() },
    ],
    [threadId, thread?.project_id, thread?.coordinator_project_id, thread?.provider, freeChat, canCompact, nativeCommands, set],
  )

  if (!thread) return null

  const cacheWindow = promptCacheWindow(thread.provider.kind, settings?.providers[thread.provider.kind]?.env)
  const promptCache = cacheWindow && promptCacheActivityAt
    ? { window: cacheWindow, lastActivityAt: promptCacheActivityAt }
    : undefined

  const onSend = async (message: UserMessage) => {
    if (running) {
      await queueMessage(threadId, message)
      return
    }
    await sendMessage(threadId, message)
  }

  const onSteer = ["claude-code", "codex", "pi", "omp"].includes(thread.provider.kind) ? async (message: UserMessage) => {
    const signature = JSON.stringify([threadId, message])
    if (steeringAttempt.current?.signature !== signature) steeringAttempt.current = { signature, id: crypto.randomUUID() }
    await rpc().call("threads.steer", { thread_id: threadId, id: steeringAttempt.current.id, message })
    steeringAttempt.current = null
  } : undefined

  const placeholder = approval
    ? (isUserInput(approval) && !connector ? "Answer the questions above" : "Resolve this approval request to continue")
    : running
      ? "Ask for follow-up changes"
      : thread.coordinator_project_id
        ? `What should we work on in ${coordinatorProjectName ?? "this project"}?`
        : undefined

  const switchCoordinatorHarness = async (
    provider: import("@/protocol").ProviderInstance,
    model?: string,
    effort?: string,
  ) => {
    if (!thread.coordinator_project_id) return
    if (running) throw new Error("Finish or stop the coordinator's current turn before changing its harness.")
    const status = providers.find((item) => item.kind === provider.kind && item.available)
    if (!status) throw new Error("Choose an available harness for the project coordinator.")
    const permissionMode = status.supported_permission_modes.includes(thread.permission_mode)
      ? thread.permission_mode
      : status.supported_permission_modes.includes("supervised")
        ? "supervised"
        : status.supported_permission_modes[0]
    if (!permissionMode) throw new Error("This harness does not expose a supported permission mode.")
    const fingerprint = JSON.stringify([thread.coordinator_project_id, provider, model, effort, permissionMode])
    if (coordinatorSwitchAttempt.current?.fingerprint !== fingerprint) {
      coordinatorSwitchAttempt.current = { fingerprint, operationId: crypto.randomUUID() }
    }
    const switched = await rpc().call("collaboration.coordinator.switch_harness", {
      operation_id: coordinatorSwitchAttempt.current.operationId,
      project_id: thread.coordinator_project_id,
      provider,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      permission_mode: permissionMode,
    })
    coordinatorSwitchAttempt.current = null
    useStore.getState().set((state) => ({ threads: { ...state.threads, [switched.thread.id]: switched.thread } }))
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <Header threadId={threadId} splitPaneId={splitPaneId} />
      <div ref={page} className="relative flex min-h-0 flex-1 flex-col">
        <div className={cn("flex min-h-0 flex-1 flex-col", ENVIRONMENT_CONTENT_INSET_MOTION_CLASS)} style={{ paddingRight: envOpen ? ENVIRONMENT_DOCKED_CONTENT_INSET_PX : 0 }}>
          <Transcript threadId={threadId} bottomInset={overlayHeight} surfaceMode={splitPaneId ? "split" : "single"} />
        </div>
        <EnvironmentPanel threadId={threadId} open={envOpen} />
        {thread.provider.kind !== "codex" && <ComputerLiveView threadId={threadId} running={running} insetEnd={envOpen ? ENVIRONMENT_DOCKED_CONTENT_INSET_PX : 0} insetBottom={overlayHeight} />}
        <div
          ref={overlay}
          className={cn("pointer-events-none absolute inset-x-0 bottom-0 z-10 flex max-h-full flex-col pb-3 sm:pb-4", CHAT_COLUMN_GUTTER, ENVIRONMENT_CONTENT_INSET_MOTION_CLASS)}
          style={{
            paddingRight: envOpen
              ? `calc(${ENVIRONMENT_DOCKED_CONTENT_INSET_PX}px + var(--thread-chat-gutter, ${CHAT_COLUMN_GUTTER_PX}px))`
              : undefined,
          }}
        >
          <div className="pointer-events-auto flex min-h-0 flex-col">
            {thread.subagent ? <SubagentBar thread={thread} /> : <Composer
              className="thread-composer"
              showProviderUsage
              providerUsage={providerUsage}
              promptCache={promptCache}
              draftKey={`thread:${threadId}`}
              ref={composer}
              placeholder={placeholder}
              running={running}
              hideFooter={!!approval}
              hideInput={hideInput}
              onStop={() => void interrupt(threadId)}
              onSend={onSend}
              onSteer={onSteer}
              mode={thread.permission_mode}
              onModeChange={(m) => changePermission(m).catch((e) => toast.error("Unable to change mode", { description: errorText(e) }))}
              provider={target?.provider ?? thread.provider}
              accountControl={target && <AccountPicker provider={target.provider} settings={settings?.providers[target.provider.kind]} inherited={!targetState?.account_override} onChange={(instance) => void chooseTarget({ ...target, provider: { ...target.provider, instance: instance ?? "default" } }, instance === null).catch((error) => toast.error("Unable to change account", { description: errorText(error) }))} />}
              providerSessionId={target?.provider.kind === thread.provider.kind && target.provider.instance === thread.provider.instance ? thread.provider_session_id : null}
              providers={composerProviders}
              onProviderChange={thread.coordinator_project_id ? canSwitchCoordinator ? (provider, choice) => switchCoordinatorHarness(provider, choice?.model, choice?.effort) : undefined : (provider, choice) => chooseTarget({ provider, model: choice?.model, effort: choice?.effort }, true)}
              model={target?.model ?? undefined}
              effort={target?.effort ?? undefined}
              surfaceMode={splitPaneId ? "split" : "single"}
              onModelChange={thread.coordinator_project_id
                ? canSwitchCoordinator
                  ? (model, effort) => switchCoordinatorHarness(thread.provider, model, effort)
                  : undefined
                : (model, effort) => target ? chooseTarget({ ...target, model, effort }) : Promise.resolve()}
              projectId={freeChat ? undefined : thread.project_id}
              commands={commands}
              onDigit={(n) => answer(n)}
              above={
                <ComposerPanelStack closed={hideInput}>
                  {targetState?.pending_permission_mode && <ComposerStackedPanel>
                    <ComposerStackedPanelRow compact>
                      <ComposerStackedPanelRowMain>Permissions change to {targetState.pending_permission_mode === "full-access" ? "Full access" : targetState.pending_permission_mode} after this turn.</ComposerStackedPanelRowMain>
                      <Button variant="ghost" size="sm" onClick={() => void rpc().call("threads.permissions.apply", { thread_id: threadId }).then(async (applied) => {
                        set((state) => ({ threads: { ...state.threads, [threadId]: applied } }))
                        setNextTarget({ threadId, state: await rpc().call("threads.target.get", { thread_id: threadId }) })
                      }).catch((error) => toast.error("Unable to apply permissions", { description: errorText(error) }))}>Stop and apply now</Button>
                    </ComposerStackedPanelRow>
                  </ComposerStackedPanel>}
                  {thread.status === "failed" && target && <AccountLimitRecovery threadId={threadId} provider={target.provider} />}
                  {thread.coordinator_project_id && <CoordinatorControlsPanel key={thread.id} thread={thread} />}
                  {helperThreads.length > 0 && <HelperThreadsPanel threads={helperThreads} />}
                  <SubagentStrip
                    threadId={threadId}
                    turnRunning={running}
                    turnId={latestTurnId}
                    hasActiveAgentTasks={activeAgentTasks.length > 0}
                    fallback={<RuntimeActivityPanel tasks={activeAgentTasks} />}
                  />
                  {otherActiveTasks.length > 0 && <RuntimeActivityPanel tasks={otherActiveTasks} />}
                  <HeldMessagesPanel threadId={threadId} />
                  {queued.length > 0 && <QueuedPanel threadId={threadId} />}
                  {!approval && questions[0] && <AsyncQuestionPanel key={questions[0].id} threadId={threadId} request={questions[0]} count={questions.length} />}
                  {approval && (
                    connector ? <ConnectorApprovalPanel key={approval.id} approval={approval} connector={connector} count={pending.length} onChoose={answer} /> : notesTasksConsent(approval) ? <NotesTasksApprovalPanel key={approval.id} consent={notesTasksConsent(approval)!} count={pending.length} onChoose={answer} /> : computerConsent(approval) ? <ComputerApprovalPanel key={approval.id} consent={computerConsent(approval)!} count={pending.length} onChoose={answer} onAlways={() => respondApproval(approval.id, { decision: "submit", response: { scope: "always" } }).catch((e) => toast.error("Unable to respond", { description: errorText(e) }))} /> : isUserInput(approval) ? <UserInputPanel key={approval.id} approval={approval} count={pending.length} /> : <ApprovalPanel key={approval.id} approval={approval} count={pending.length} onChoose={answer} />
                  )}
                </ComposerPanelStack>
              }
            />}
          </div>
        </div>
      </div>
    </div>
  )
}

function AccountLimitRecovery({ threadId, provider }: { threadId: string; provider: import("@/protocol").ProviderInstance }) {
  const error = useStore((state) => {
    const blocks = state.transcripts[threadId]?.blocks ?? []
    for (let index = blocks.length - 1; index >= 0; index--) { const block = blocks[index]; if (block.kind === "turn_end") return block.error }
    return null
  })
  const threadStatus = useStore((state) => state.threads[threadId]?.status)
  const limits = useStore((state) => state.transcripts[threadId]?.providerUsage?.limits)
  const now = useNow()
  const confirmedLimit = limits?.some((limit) => limit.used_percent >= 100 && (limit.window_minutes === 300 || limit.window_minutes === 10080) && (!limit.resets_at || limit.resets_at > now / 1000))
  const accounts = useStore((state) => state.settings?.providers[provider.kind]?.accounts)
  const [selected, setSelected] = useState("")
  const [busy, setBusy] = useState(false)
  const attempt = useRef<string | null>(null)
  const confirmedError = threadStatus === "failed" && !!error && /(usage limit|quota|rate_limit_exceeded|hit your limit)/i.test(error) && /(5.hour|five.hour|week)/i.test(error)
  if (!confirmedLimit && !confirmedError) return null
  const options = [{ id: "default", name: "Default account" }, ...Object.entries(accounts ?? {}).map(([id, account]) => ({ id, name: account.name }))].filter((account) => account.id !== provider.instance)
  const choice = options.find((account) => account.id === selected) ?? options[0]
  return <ComposerStackedPanel><ComposerStackedPanelRow compact>
    <ComposerStackedPanelRowMain><span>Account usage limit reached</span><span className="block text-xs text-muted-foreground">Choose an account to continue the interrupted task in this conversation.</span></ComposerStackedPanelRowMain>
    {choice ? <><Menu><MenuTrigger render={<Button variant="ghost" size="sm" />}>{choice.name}</MenuTrigger><ComposerPickerMenuPopup align="end" side="top"><MenuGroup>{options.map((account) => <MenuItem key={account.id} onClick={() => { setSelected(account.id); attempt.current = null }}>{account.name}</MenuItem>)}</MenuGroup></ComposerPickerMenuPopup></Menu>
      <Button variant="chrome-outline" size="sm" disabled={busy} onClick={() => {
        setBusy(true); attempt.current ??= crypto.randomUUID()
        void rpc().call("threads.switch_continue", { thread_id: threadId, provider: { kind: provider.kind, instance: choice.id }, message_id: attempt.current }).catch((problem) => toast.error("Unable to continue", { description: errorText(problem) })).finally(() => setBusy(false))
      }}>Switch and continue</Button></> : <Button variant="ghost" size="sm" onClick={() => useStore.getState().set({ settingsOpen: true, settingsTab: "agents" })}>Add an account</Button>}
  </ComposerStackedPanelRow></ComposerStackedPanel>
}

function CoordinatorControlsPanel({ thread }: { thread: import("@/protocol").Thread }) {
  const [setup, setSetup] = useState<boolean | undefined>(undefined)
  useEffect(() => {
    const runtime = activeRuntime()
    let disposed = false
    let generation = 0
    const load = async () => {
      if (!thread.collaboration_group_id) return
      const request = ++generation
      try {
        const detail = await runtime.rpc().call("collaboration.groups.get", { group_id: thread.collaboration_group_id })
        if (!disposed && request === generation && runtime === activeRuntime()) setSetup(detail.coordinator_setup_complete ?? undefined)
      } catch { /* The work panel exposes connection errors and retries. */ }
    }
    void load()
    const unsubscribe = subscribeCollaboration((event) => {
      if (!event || (event.kind === "collaboration_context_updated" && event.entry.group_id === thread.collaboration_group_id && event.entry.key === "project.setup")) void load()
    })
    return () => { disposed = true; unsubscribe() }
  }, [thread.collaboration_group_id])
  const set = useStore((state) => state.set)
  const open = (view: "work" | "context" | "results") => {
    set({ rightOpen: true, rightTab: "collaboration" })
    requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("kybern:collaboration-view", { detail: view })))
  }
  return (
    <ComposerStackedPanel>
      {setup !== undefined && <ComposerStackedPanelRow compact>
        <ComposerStackedPanelRowMain>
          <span role="status" className="text-xs text-muted-foreground">{setup ? "Setup complete" : thread.status === "running" ? "Setting up project" : thread.status === "failed" ? "Setup needs attention" : "Project setup"}</span>
        </ComposerStackedPanelRowMain>
      </ComposerStackedPanelRow>}
      <ComposerStackedPanelRow compact className="gap-1.5">
        <ComposerStackedPanelRowMain>
          <UsersIcon className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />
          <span className="sr-only">Project coordinator controls</span>
        </ComposerStackedPanelRowMain>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button variant="ghost" size="chip" onClick={() => open("work")}>Workers</Button>
          <Button variant="ghost" size="chip" onClick={() => open("context")}>Knowledge</Button>
          <Button variant="ghost" size="chip" onClick={() => open("results")}>Results</Button>
        </div>
      </ComposerStackedPanelRow>
    </ComposerStackedPanel>
  )
}

function HelperThreadsPanel({ threads }: { threads: import("@/protocol").Thread[] }) {
  const set = useStore((state) => state.set)
  const working = threads.filter((thread) => thread.status === "running").length
  const approvals = threads.filter((thread) => thread.status === "awaiting-approval").length
  const previewProviders = [...new Set(threads.map((thread) => thread.provider.kind))].slice(0, 3)
  const previewHarnesses = previewProviders.map((kind) => PROVIDER_LABEL[kind]).join(", ")
  const [open, setOpen] = useState(() => (working > 0 || approvals > 0) && threads.length <= 3)
  const summary = approvals > 0 ? `${approvals} ${approvals === 1 ? "needs" : "need"} approval` : working > 0 ? `${working} working` : null
  return (
    <ComposerStackedPanel>
      <ComposerStackedPanelRow compact className="gap-1">
        <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-start outline-hidden focus-visible:ring-1 focus-visible:ring-ring">
          <span aria-label={`Helpers using ${previewHarnesses}`} role="img" title={previewHarnesses} className="flex shrink-0 items-center">
            {previewProviders.map((kind, index) => (
              <span key={kind} className={cn("composer-harness-mark flex size-5 items-center justify-center rounded-full", index > 0 && "-ms-1")}>
                <ProviderMark kind={kind} size={16} className="size-4" />
              </span>
            ))}
          </span>
          <span className="truncate font-medium text-foreground/85">{threads.length} {threads.length === 1 ? "helper" : "helpers"}{summary ? ` · ${summary}` : ""}</span>
          <DisclosureChevron open={open} className="shrink-0 text-muted-foreground/60" />
        </button>
        <Button variant="ghost" size="chip" onClick={() => set({ rightOpen: true, rightTab: "collaboration" })}>Details</Button>
      </ComposerStackedPanelRow>
      <DisclosureRegion open={open}>
        <div className={cn("max-h-44 overflow-y-auto", COMPOSER_STACKED_PANEL_DIVIDER_CLASS_NAME)}>
          {threads.map((thread) => (
            <button
              key={thread.id}
              type="button"
              onClick={() => {
                useStore.getState().selectThread(thread.id)
                void loadThread(thread.id)
              }}
              className="flex h-8 w-full min-w-0 items-center gap-2 px-3 text-start text-[length:var(--app-font-size-ui,12px)] outline-hidden hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <ProviderMark kind={thread.provider.kind} size={12} className="size-3 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-foreground/85">{thread.title || "Untitled"}</span>
              <span className={cn("shrink-0 text-[length:var(--app-font-size-ui-2xs,10px)]", thread.status === "failed" ? "text-destructive" : thread.status === "awaiting-approval" ? "text-amber-600 dark:text-amber-300" : "text-muted-foreground/60")}>
                {thread.status === "running" ? "Working" : thread.status === "awaiting-approval" ? "Needs approval" : thread.status === "failed" ? "Failed" : "Idle"}
              </span>
            </button>
          ))}
        </div>
      </DisclosureRegion>
    </ComposerStackedPanel>
  )
}

function RuntimeActivityPanel({ tasks }: { tasks: RuntimeTask[] }) {
  const set = useStore((state) => state.set)
  const foreground = tasks.find((task) => !task.backgrounded)
  const primary = foreground ?? tasks[0]
  const detail = foreground?.title ?? tasks[0]?.title
  return (
    <ComposerStackedPanel className="t-panel-enter">
      <ComposerStackedPanelRow>
        <ComposerStackedPanelRowMain>
          {primary?.kind === "process"
            ? <ComputerTerminalIcon className={cn(COMPOSER_STACKED_PANEL_ICON_CLASS_NAME, "translate-y-px")} />
            : primary?.kind === "agent"
              ? <RobotIcon className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />
              : <WorkflowIcon className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />}
          <span className="truncate font-medium text-foreground/85">{activeTaskSummary(tasks)}</span>
          {detail && <span className="hidden min-w-0 truncate text-muted-foreground/55 sm:inline">· {detail}</span>}
        </ComposerStackedPanelRowMain>
        <Button variant="ghost" size="chip" onClick={() => set({ rightOpen: true, rightTab: "activity" })}>
          View activity
        </Button>
      </ComposerStackedPanelRow>
    </ComposerStackedPanel>
  )
}

export function QueuedPanel({ threadId }: { threadId: ThreadId }) {
  const queued = useStore((s) => s.queued[threadId] ?? EMPTY)
  const [expanded, setExpanded] = useState(false)
  // Updates from other agents (legacy collaboration text, messages from threads, delegated results) wait behind one row.
  const isUpdate = (q: { message: UserMessage }) => !!collaborationPreview(promptText(q.message)) || !!structuredMessageSummary(q.message)
  const updates = queued.filter(isUpdate)
  const prompts = queued.filter(q => !isUpdate(q))
  return <ComposerStackedPanel className="composer-queue-panel flex max-h-64 flex-col overflow-y-auto">
    {updates.length > 0 && <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}
      className="flex min-h-9 w-full items-center gap-2 px-3 py-2 text-start text-xs text-muted-foreground hover:text-foreground">
      <DisclosureChevron open={expanded} />
      <span>{updates.length} agent {updates.length === 1 ? "update" : "updates"} waiting</span>
    </button>}
    {prompts.length > 0 && <div className="px-3 pt-2 text-xs text-muted-foreground">Queued · {prompts.length}</div>}
    {queued.filter(q => expanded || !isUpdate(q)).map((q, i) => <QueuedRow key={q.id} item={{ ...q, thread_id: threadId }} divided={i > 0} />)}
  </ComposerStackedPanel>
}

function QueuedRow({ item, divided }: { item: import("@/protocol").QueuedMessage; divided: boolean }) {
  const [entered, setEntered] = useState(false)
  const legacy = collaborationPreview(promptText(item.message))
  // A message from another thread or a batch of delegated results reads from its parts, not from prompt text.
  const structured = structuredMessageSummary(item.message)
  const preview = legacy ?? (structured ? { purpose: structured, senderId: null, body: structuredMessageBody(item.message) ?? "" } : null)
  const sender = useStore(state => legacy?.senderId ? state.threads[legacy.senderId]?.title || "Helper" : "You")
  const [showBody, setShowBody] = useState(false)
  const connected = useStore((s) => s.connection.state === "open")
  const [edit, setEdit] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const contextCount = item.message.parts.filter((part) => part.type !== "text").length
  const run = async (save: boolean) => {
    setBusy(true)
    try {
      if (save) {
        await rpc().call("queue.update", { ...item, message: replacePromptText(item.message, edit ?? promptText(item.message)) })
        setEdit(null)
      } else await removeQueuedMessage(item.thread_id, item.id)
    } catch (error) { toast.error("Unable to update follow-up", { description: errorText(error) }) }
    finally { setBusy(false) }
  }
  return <ComposerStackedPanelRow compact data-testid="queued-follow-up-row" onAnimationEnd={(event) => { if (event.target === event.currentTarget) setEntered(true) }} className={cn(!entered && "t-row-enter", divided && COMPOSER_STACKED_PANEL_DIVIDER_CLASS_NAME)}>
    <ComposerStackedPanelRowMain>
      <SteerIcon className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />
      <div className="min-w-0 flex-1">
        {edit === null ? <button type="button" aria-expanded={showBody} onClick={() => setShowBody(value => !value)} className="w-full text-start">
          <span className="flex min-w-0 items-center gap-2"><span className={cn(COMPOSER_STACKED_PANEL_PREVIEW_MARKDOWN_CLASS_NAME, "min-w-0 flex-1")}>{structured ? structured : preview ? `${preview.purpose} · ${sender}` : promptText(item.message) || "Queued follow-up"}</span><DisclosureChevron open={showBody} /></span>
          {showBody && <span className="block whitespace-pre-wrap break-words py-2 text-sm font-normal leading-relaxed">{preview?.body ?? promptText(item.message)}</span>}
        </button>
          : <Textarea aria-label="Edit queued prompt" value={edit} disabled={busy} onChange={(e) => setEdit(e.target.value)} size="sm" />}
        {contextCount > 0 && <span className="block text-xs text-muted-foreground">{contextCount} attached context {contextCount === 1 ? "item" : "items"}</span>}
      </div>
    </ComposerStackedPanelRowMain>
    <div className="flex shrink-0 items-center gap-0">
      {edit === null ? (!preview && <Button variant="subtle" size="chip" disabled={!connected || busy} onClick={() => setEdit(promptText(item.message))}><PencilIcon /> Edit</Button>)
        : <><Button variant="subtle" size="chip" disabled={!connected || busy || (!edit.trim() && !contextCount)} onClick={() => void run(true)}>Save</Button><Button variant="ghost" size="chip" disabled={busy} onClick={() => setEdit(null)}>Cancel</Button></>}
      <IconButton variant="ghost" size="icon-chip" label="Delete queued follow-up" tooltip="Remove" disabled={!connected || busy} onClick={() => void run(false)}><Trash2 /></IconButton>
    </div>
  </ComposerStackedPanelRow>
}

function approvalPrompt(a: ApprovalRequest): { prompt: string; detail: React.ReactNode } {
  if (a.tool_name === "ExitPlanMode") {
    const input = a.input && typeof a.input === "object" ? a.input as Record<string, unknown> : {}
    const plan = typeof input.plan === "string" ? input.plan : ""
    return { prompt: "Start implementing this plan?", detail: plan ? <div className="mt-3 max-h-64 overflow-auto"><Markdown text={plan} /></div> : <p className="mt-2 text-xs text-muted-foreground">Review the agent’s plan above before continuing.</p> }
  }
  const { verb, detail } = toolLine({ id: a.tool_call_id ?? "", name: a.tool_name, input: a.input })
  const mono = (s: string) => (
    <pre className="mt-2 overflow-hidden rounded-md bg-[var(--color-background-elevated-secondary)] px-2.5 py-1.5 font-mono text-[11.5px] leading-snug text-foreground/85">
      <code className="block truncate">{s}</code>
    </pre>
  )
  const file = (path: string) => (
    <div className="mt-2">
      <p className="truncate text-[12.5px] leading-tight font-medium text-foreground/85">{basename(path)}</p>
      <p className="mt-0.5 truncate font-mono text-[10.5px] leading-tight text-muted-foreground/55">{path}</p>
    </div>
  )
  if (verb === "Ran") return { prompt: "Approve this command?", detail: detail ? mono(detail) : null }
  if (verb === "Read") return { prompt: "Approve reading this file?", detail: detail ? file(detail) : null }
  if (verb === "Edited" || verb === "Wrote") return { prompt: "Approve this file change?", detail: detail ? file(detail) : null }
  const body = permissionBody(a.input)
  return {
    prompt: a.summary ? `${a.summary}?` : "Grant these permissions?",
    detail: body ? (
      <div className="mt-2">
        <pre className="max-h-36 overflow-auto rounded-md bg-[var(--color-background-elevated-secondary)] px-2.5 py-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-foreground/85">{body}</pre>
      </div>
    ) : (
      <p className="mt-2 text-[12px] text-muted-foreground/65">Review the request to continue.</p>
    ),
  }
}

function permissionBody(input: JsonValue): string {
  if (!input || typeof input !== "object") return ""
  const o = input as Record<string, unknown>
  for (const k of ["command", "diff", "new_string", "content", "patch"]) {
    const v = o[k]
    if (typeof v === "string" && v.trim()) return v
  }
  return JSON.stringify(input, null, 2)
}

export function ApprovalPanel({ approval, count, onChoose }: { approval: ApprovalRequest; count: number; onChoose: (n: number) => void }) {
  const { prompt, detail } = approvalPrompt(approval)
  return (
    <ComposerStackedPanel className="composer-approval-panel t-panel-enter px-3.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-[13px] leading-snug font-medium text-foreground/90">
          {prompt}
          <span className="ml-1.5 text-[11px] font-normal text-muted-foreground/50">{approval.tool_name}</span>
        </p>
        {count > 1 && (
          <span className="flex h-4 shrink-0 items-center rounded bg-[var(--color-background-elevated-secondary)] px-1 text-[9.5px] font-medium text-[var(--color-text-foreground-secondary)] tabular-nums">
            1/{count}
          </span>
        )}
      </div>
      {detail}
      <ApprovalActions primaryLabel={approval.tool_name === "ExitPlanMode" ? "Start implementing" : "Approve once"} primaryShortcut={1} sessionShortcut={approval.tool_name === "ExitPlanMode" ? undefined : 2} onChoose={onChoose} />
    </ComposerStackedPanel>
  )
}

/** Kybern's own consent before an agent uses an app. Same actions and digits as other approvals. */
export function ComputerApprovalPanel({ consent, count, onChoose, onAlways }: { consent: { app: string; foreground: boolean }; count: number; onChoose: (n: number) => void; onAlways: () => void }) {
  return (
    <ComposerStackedPanel className="composer-approval-panel t-panel-enter px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5">
        <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-background-elevated-secondary)] text-muted-foreground">
          <DeviceLaptopIcon className="size-4" />
        </span>
        <div className="min-w-48 flex-1">
          <p className="flex items-start gap-2 text-[13px] leading-snug font-medium text-balance text-foreground/90">
            {consent.foreground ? `Let this chat take over your cursor in ${consent.app}?` : `Let this chat use ${consent.app}?`}
            {count > 1 && (
              <span className="mt-px flex h-4 shrink-0 items-center rounded bg-[var(--color-background-elevated-secondary)] px-1 text-[9.5px] font-medium text-[var(--color-text-foreground-secondary)] tabular-nums">
                1/{count}
              </span>
            )}
          </p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-pretty text-muted-foreground/65">
            {consent.foreground
              ? `${consent.app} comes to the front while the agent works. Avoid typing until it finishes.`
              : "It works in the background. Your cursor and keyboard stay yours."}
          </p>
        </div>
        <ApprovalActions
          className="mt-0 ms-auto"
          primaryLabel="Allow once"
          primaryShortcut={1}
          sessionShortcut={2}
          onChoose={onChoose}
          always={consent.foreground ? undefined : { label: `Always allow ${consent.app}`, onChoose: onAlways }}
        />
      </div>
    </ComposerStackedPanel>
  )
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** The quiet line under the prompt: only what the daemon's summary does not already say. */
function notesTasksMeta(consent: NotesTasksConsent): string[] {
  switch (consent.action) {
    case "create_task":
      return [
        "Lands in Inbox",
        ...(consent.priority > 0 && consent.priorityLabel ? [`${consent.priorityLabel} priority`] : []),
        ...(consent.criteria > 0 ? [plural(consent.criteria, "criterion", "criteria")] : []),
      ]
    case "update_note":
      return [
        ...(consent.title ? [`New title “${consent.title}”`] : []),
        ...(consent.preview ? ["Replaces the text"] : []),
      ]
    case "claim_task":
      return ["Shows as Running while this chat works on it"]
    default:
      return []
  }
}

const NOTES_TASKS_CHECKLIST_LIMIT = 5

/** New text, a few lines at most; the fade says there is more. */
function NotesTasksPreview({ text, items }: { text: string; items: { text: string; checked: boolean }[] }) {
  const box = useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = useState(false)
  useLayoutEffect(() => {
    const node = box.current
    if (node) setOverflows(node.scrollHeight > node.clientHeight + 1)
  }, [text])
  const shown = items.slice(0, NOTES_TASKS_CHECKLIST_LIMIT)
  return (
    <div className="mt-2 rounded-md bg-[var(--color-background-elevated-secondary)] px-2.5 py-2 text-[12px] leading-[1.45] text-foreground/85">
      {text && (
        <div
          ref={box}
          className={cn(
            "max-h-[4.35em] overflow-hidden break-words whitespace-pre-wrap",
            overflows && "[mask-image:linear-gradient(to_bottom,black_55%,transparent)]",
          )}
        >
          {text}
        </div>
      )}
      {shown.length > 0 && (
        <ul aria-label="Acceptance criteria" className={cn("flex flex-col gap-0.5", text && "mt-1.5")}>
          {shown.map((item, index) => (
            <li key={index} className="flex min-w-0 items-center gap-2">
              <span aria-hidden className={cn("size-3 shrink-0 rounded-[3px] border border-current opacity-45", item.checked && "bg-current")} />
              <span className="min-w-0 truncate">{item.text}</span>
            </li>
          ))}
          {items.length > shown.length && <li className="ps-5 text-muted-foreground/65">{plural(items.length - shown.length, "more criterion", "more criteria")}</li>}
        </ul>
      )}
    </div>
  )
}

/** Kybern's own consent before an agent files or changes a note or task. Same digits as other approvals. */
export function NotesTasksApprovalPanel({ consent, count, onChoose }: { consent: NotesTasksConsent; count: number; onChoose: (n: number) => void }) {
  const Icon = consent.kind === "task" ? ListChecksIcon : NoteIcon
  const meta = notesTasksMeta(consent)
  const preview = useMemo(() => splitChecklistPreview(consent.preview), [consent.preview])
  const hasPreview = preview.text.length > 0 || preview.items.length > 0
  return (
    <ComposerStackedPanel className="composer-approval-panel t-panel-enter px-3.5 py-3">
      <div className="flex items-start gap-3">
        <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-background-elevated-secondary)] text-muted-foreground">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1 pt-px">
          <p className="flex items-start gap-2 text-[13px] leading-snug font-medium text-balance text-foreground/90">
            <span className="min-w-0 break-words">{consent.summary ? `${consent.summary}?` : consent.kind === "task" ? "Allow this change to a task?" : "Allow this change to a note?"}</span>
            {count > 1 && (
              <span className="mt-px flex h-4 shrink-0 items-center rounded bg-[var(--color-background-elevated-secondary)] px-1 text-[9.5px] font-medium text-[var(--color-text-foreground-secondary)] tabular-nums">
                1/{count}
              </span>
            )}
          </p>
          {meta.length > 0 && <p className="mt-0.5 truncate text-[12px] leading-relaxed text-muted-foreground/65">{meta.join(" · ")}</p>}
          {hasPreview && <NotesTasksPreview text={preview.text} items={preview.items} />}
        </div>
      </div>
      <ApprovalActions primaryLabel="Allow once" primaryShortcut={1} sessionShortcut={2} sessionLabel="Allow for this thread" onChoose={onChoose} />
    </ComposerStackedPanel>
  )
}

/** Consent for a harness to drive an app on this machine. Same card as other approvals, so the digits work the same. */
export function ConnectorApprovalPanel({ approval, connector, count, onChoose }: { approval: ApprovalRequest; connector: ConnectorApproval; count: number; onChoose: (n: number) => void }) {
  const canPersist = connector.persist.includes("session")
  const prompt = connector.app ? `Allow ${connector.connector} to use ${connector.app}?` : connector.message || `Allow ${connector.connector}?`
  return (
    <ComposerStackedPanel className="composer-approval-panel t-panel-enter px-3.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-[13px] leading-snug font-medium text-foreground/90">
          {prompt}
          <span className="ml-1.5 text-[11px] font-normal text-muted-foreground/50">{approvalServerName(approval.input) ?? approval.tool_name}</span>
        </p>
        {count > 1 && (
          <span className="flex h-4 shrink-0 items-center rounded bg-[var(--color-background-elevated-secondary)] px-1 text-[9.5px] font-medium text-[var(--color-text-foreground-secondary)] tabular-nums">
            1/{count}
          </span>
        )}
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground/65">
        {connector.subtitle || `${connector.connector} will see this app’s window and click and type in it. Watch what it does.`}
      </p>
      <ApprovalActions primaryLabel="Allow once" primaryShortcut={canPersist ? 2 : 1} sessionShortcut={canPersist ? 1 : undefined} onChoose={onChoose} />
    </ComposerStackedPanel>
  )
}

/** Keep the common decision visible and less frequent scope/stop actions grouped. */
function ApprovalActions({ primaryLabel, primaryShortcut, sessionShortcut, sessionLabel, onChoose, className, always }: {
  primaryLabel: string
  primaryShortcut: number
  sessionShortcut?: number
  /** Shows the session allowance as a button with this label instead of a menu item. */
  sessionLabel?: string
  onChoose: (choice: number) => void
  className?: string
  /** A remembered allowance, e.g. "Always allow Calculator". */
  always?: { label: string; onChoose: () => void }
}) {
  return <div className={cn("mt-3 flex flex-wrap items-center justify-end gap-2", className)}>
    <Menu>
      <MenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label="More approval options"><EllipsisIcon /></Button>} />
      <ComposerPickerMenuPopup align="start" side="top">
        {sessionShortcut !== undefined && !sessionLabel && <MenuItem onClick={() => onChoose(sessionShortcut)}>Allow for this session<MenuShortcut>{sessionShortcut}</MenuShortcut></MenuItem>}
        {always && <MenuItem onClick={always.onChoose}>{always.label}</MenuItem>}
        <MenuItem onClick={() => onChoose(4)}>Cancel turn<MenuShortcut>4</MenuShortcut></MenuItem>
      </ComposerPickerMenuPopup>
    </Menu>
    <Button type="button" variant="chrome-outline" size="sm" onClick={() => onChoose(3)}>Decline<kbd className="text-[0.85em] opacity-60" aria-hidden="true">3</kbd></Button>
    {sessionShortcut !== undefined && sessionLabel && <Button type="button" variant="chrome-outline" size="sm" onClick={() => onChoose(sessionShortcut)}>{sessionLabel}<kbd className="text-[0.85em] opacity-60" aria-hidden="true">{sessionShortcut}</kbd></Button>}
    <Button type="button" size="sm" onClick={() => onChoose(primaryShortcut)}>{primaryLabel}<kbd className="text-[0.85em] opacity-60" aria-hidden="true">{primaryShortcut}</kbd></Button>
  </div>
}

function Header({ threadId, splitPaneId }: { threadId: ThreadId; splitPaneId?: PaneId }) {
  const [deleting, setDeleting] = useState(false)
  const thread = useStore((s) => s.threads[threadId])
  // The chain above this thread, topmost first. Child progress never re-renders the header.
  const ancestors = useAncestors(threadId)
  const mainThread = thread?.subagent ? undefined : ancestors[0]
  const providers = useStore((s) => s.providers)
  const splitView = useStore((s) => s.splitView)
  const set = useStore((s) => s.set)
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState("")
  if (!thread) return null

  const commitRename = () => {
    setRenaming(false)
    const next = title.trim()
    if (next && next !== thread.title) updateThread(threadId, { title: next }).catch((e) => toast.error("Unable to rename", { description: errorText(e) }))
  }
  const others = providers.filter((p) => p.available && p.kind !== thread.provider.kind)
  const splitMode = !!splitPaneId && !!splitView
  const canSplitRight = !splitView || !splitPaneId || canSplitPane(splitView.root, splitPaneId, "horizontal")
  const canSplitDown = !splitView || !splitPaneId || canSplitPane(splitView.root, splitPaneId, "vertical")
  const split = (direction: "horizontal" | "vertical") => {
    if (splitPaneId) useStore.getState().focusSplitPane(splitPaneId)
    useStore.getState().splitFocusedPane(direction)
  }

  return (
    <SurfaceHeader
      environment
      inline={!!splitPaneId}
      trailing={
        <>
      {deleting && thread && <DeleteCoordinatorDialog thread={thread} onClose={() => setDeleting(false)} />}
          {!thread.subagent && others.length > 0 && (
            <Menu>
              <MenuTrigger render={<ChatHeaderButton type="button" tone="outline" className="gap-1.5" />}>
                <HandoffIcon className="size-[1em] shrink-0 opacity-80" />
                <span className="truncate font-normal @max-[700px]:sr-only">Hand off</span>
              </MenuTrigger>
              <ComposerPickerMenuPopup align="end" side="bottom" className="w-48 min-w-48">
                <MenuGroup>
                  {others.map((p) => (
                    <MenuItem key={p.kind} onClick={() => set({ handoffThread: threadId, handoffTarget: p.kind })}>
                      <ProviderMark kind={p.kind} size={14} className="size-3.5 shrink-0 opacity-100" />
                      Hand off to {PROVIDER_LABEL[p.kind] ?? p.display_name}
                    </MenuItem>
                  ))}
                </MenuGroup>
              </ComposerPickerMenuPopup>
            </Menu>
          )}
          <Menu>
            <MenuTrigger render={<ChatHeaderIconButton label="Thread actions" />}>
              <EllipsisIcon className="size-3.5" />
            </MenuTrigger>
            <ComposerPickerMenuPopup align="end" side="bottom" className="action-menu">
              <MenuGroup>
                <MenuItem disabled={!canSplitRight} onClick={() => split("horizontal")}>
                  <SquareSplitVertical /> Split right
                  {!splitMode && <MenuShortcut>{mod}\</MenuShortcut>}
                </MenuItem>
                <MenuItem disabled={!canSplitDown} onClick={() => split("vertical")}>
                  <SquareSplitHorizontal /> Split down
                  {!splitMode && <MenuShortcut>{mod}⇧\</MenuShortcut>}
                </MenuItem>
                {splitMode && (
                  <>
                    <MenuItem onClick={() => splitPaneId && useStore.getState().maximizeSplitPane(splitPaneId)}>
                      <Maximize2 /> Expand this pane
                    </MenuItem>
                    <MenuItem onClick={() => splitPaneId && useStore.getState().closeSplitPane(splitPaneId)}>
                      <XIcon /> Close pane
                    </MenuItem>
                  </>
                )}
              </MenuGroup>
              {thread.subagent && (
                <>
                  <MenuSeparator />
                  <MenuGroup>
                    <MenuItem onClick={() => void openParentOf(thread)}>
                      <BackToParentIcon /> Open parent
                      <MenuShortcut>{mod}↑</MenuShortcut>
                    </MenuItem>
                    {subagentPhase(thread.subagent.status) === "working" && thread.subagent.capabilities?.stop !== false && (
                      <MenuItem onClick={() => void stopOneSubagent(thread)}>
                        <StopIcon /> Stop
                      </MenuItem>
                    )}
                  </MenuGroup>
                </>
              )}
              {/* A subagent thread is read-only: it cannot be renamed, pinned or archived. */}
              {!thread.subagent && (
                <>
                  <MenuSeparator />
                  <MenuGroup>
                    <MenuItem
                      onClick={() => {
                        setTitle(thread.title)
                        setRenaming(true)
                      }}
                    >
                      <PencilIcon /> Rename thread
                    </MenuItem>
                    <MenuItem onClick={() => updateThread(threadId, { pinned: !thread.pinned })}>
                      {thread.pinned ? <PinFilledIcon /> : <PinIcon />}
                      {thread.pinned ? "Unpin" : "Pin"}
                    </MenuItem>
                  </MenuGroup>
                </>
              )}
              {!thread.coordinator_project_id && !thread.subagent && (
                <>
                  <MenuSeparator />
                  <MenuGroup>
                    <MenuItem variant="destructive" onClick={() => thread.coordinator_project_id ? setDeleting(true) : void archiveThread(threadId).catch((error) => toast.error(errorText(error)))}>
                      <ArchiveIcon /> {thread.coordinator_project_id ? "Delete coordinator" : "Archive"}
                    </MenuItem>
                    {thread.worktree && !thread.delegation && !thread.subagent && <MenuItem onClick={() => offerWorktreeCleanup(threadId)}>Remove worktree…</MenuItem>}
                  </MenuGroup>
                </>
              )}
            </ComposerPickerMenuPopup>
          </Menu>
        </>
      }
    >
      {thread.subagent ? (
        <SubagentBreadcrumb thread={thread} ancestors={ancestors} />
      ) : (
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-2">
          {mainThread && (
            <ChatHeaderButton
              type="button"
              tone="plain"
              className="max-w-44 gap-1.5 px-1.5 text-muted-foreground"
              title={`Back to main thread: ${mainThread.title || "Untitled"}`}
              onClick={() => {
                useStore.getState().selectThread(mainThread.id)
                void loadThread(mainThread.id)
              }}
            >
              <ArrowLeftIcon className="size-3.5 shrink-0" />
              <span className="truncate">Main thread</span>
            </ChatHeaderButton>
          )}
          <div className="flex min-w-0 items-center gap-2">
            <span className="inline-flex size-3.5 shrink-0 items-center justify-center" title={PROVIDER_LABEL[thread.provider.kind]}>
              <ProviderMark kind={thread.provider.kind} tone="header" size={14} className="size-3.5" />
            </span>
            {renaming ? (
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename()
                  if (e.key === "Escape") setRenaming(false)
                }}
                className="[-webkit-app-region:no-drag] max-w-[clamp(12rem,42vw,36rem)] rounded-sm bg-transparent px-1 font-system-ui text-[length:var(--app-font-size-ui,12px)] text-foreground outline-none ring-1 ring-ring"
              />
            ) : (
              <h2
                data-tauri-drag-region="false"
                title={thread.title || "Untitled"}
                onDoubleClick={() => {
                  setTitle(thread.title)
                  setRenaming(true)
                }}
                className="max-w-[clamp(12rem,42vw,36rem)] truncate font-system-ui text-[length:var(--app-font-size-ui,12px)] font-normal text-foreground"
              >
                <TextSwap text={thread.title || "Untitled"} />
              </h2>
            )}
            {thread.coordinator_project_id && <span className="shrink-0 text-[10px] font-medium text-muted-foreground/60">Project coordinator</span>}
          </div>
        </div>
      </div>
      )}
    </SurfaceHeader>
  )
}
