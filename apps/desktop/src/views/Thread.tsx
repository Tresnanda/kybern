import { collaborationPreview } from "../../../../packages/kybern-client/src/collaboration"
import { promptText, replacePromptText } from "../../../../packages/kybern-client/src/prompts"
import { DeleteCoordinatorDialog } from "./DeleteCoordinatorDialog"
import { Textarea } from "@/components/kit/textarea"
import { observeResizeFrame } from "@/lib/resizeObserver"
import { AsyncQuestionPanel } from "./AsyncQuestionPanel"
import { Markdown } from "@/components/kybern/Markdown"
import { connectorApproval, connectorApprovalResponse, isUserInput, type ConnectorApproval } from "@/lib/userInput"
import { UserInputPanel } from "./UserInputPanel"
import { TextSwap } from "@/components/kybern/motion"
// Thread route: Header (provider glyph, title, Hand off,
// actions, dock toggle), the transcript scrolling under the frosted composer,
// queued follow-ups stacked above the input and the approval card.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import { ProviderMark } from "@/components/kybern/bits"
import { Button } from "@/components/kit/button"
import { DisclosureChevron } from "@/components/kit/DisclosureChevron"
import { DisclosureRegion } from "@/components/kit/DisclosureRegion"
import { IconButton } from "@/components/kit/icon-button"
import { ComposerChoiceRow } from "@/components/kit/chat/ComposerChoiceRow"
import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { ComposerPanelStack, ComposerStackedPanel, COMPOSER_STACKED_PANEL_DIVIDER_CLASS_NAME } from "@/components/kit/chat/ComposerStackedPanel"
import { ComposerStackedPanelRow, ComposerStackedPanelRowMain } from "@/components/kit/chat/ComposerStackedPanelContent"
import { Menu, MenuGroup, MenuItem, MenuSeparator, MenuShortcut, MenuTrigger } from "@/components/kit/menu"
import { PROVIDER_LABEL, basename, mod, toolLine } from "@/lib/format"
import { activeTaskSummary } from "@/lib/runtimeActivity"
import {
  ArrowLeftIcon,
  ArchiveIcon,
  ChangesIcon,
  ClockIcon,
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
} from "@/lib/kit/icons"
import { COMPOSER_STACKED_PANEL_ICON_CLASS_NAME, COMPOSER_STACKED_PANEL_PREVIEW_MARKDOWN_CLASS_NAME } from "@/components/kit/chat/composerStackedPanelStyles"
import { openExternal } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import type { ApprovalRequest, JsonValue, RuntimeTask, ThreadId, UserMessage } from "@/protocol"
import { newThread } from "@/state/nav"
import { activeRuntime, subscribeCollaboration, archiveThread, errorText, interrupt, loadThread, respondApproval, rpc, sendMessage, queueMessage, removeQueuedMessage, updateThread } from "@/state/rpc"
import { canSplitPane, type PaneId } from "@/state/splitView"
import { isRuntimeTaskActive, useStore } from "@/state/store"

import { ENVIRONMENT_CONTENT_INSET_MOTION_CLASS } from "@/components/kit/chat/composerPickerStyles"

import { Composer, type ComposerHandle, type SlashCommand } from "./Composer"
import { ENVIRONMENT_DOCKED_CONTENT_INSET_PX, EnvironmentPanel } from "./Environment"
import { Transcript } from "./Transcript"
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
  showSidebarControls = true,
}: {
  threadId: ThreadId
  splitPaneId?: PaneId
  isFocused?: boolean
  showSidebarControls?: boolean
}) {
  const steeringAttempt = useRef<{ signature: string; id: string } | null>(null)
  const coordinatorSwitchAttempt = useRef<{ fingerprint: string; operationId: string } | null>(null)
  const thread = useStore((s) => s.threads[threadId])
  const coordinatorProjectName = useStore((s) =>
    thread?.coordinator_project_id ? s.projects[thread.project_id]?.name : undefined
  )
  const providerUsage = useStore((s) => s.transcripts[threadId]?.providerUsage)
  const loaded = useStore((s) => s.transcripts[threadId]?.loaded)
  const questions = useStore((s) => s.transcripts[threadId]?.pendingQuestions ?? EMPTY)
  const pending = useStore((s) => s.transcripts[threadId]?.pendingApprovals ?? EMPTY)
  const queued = useStore((s) => s.queued[threadId] ?? EMPTY)
  const runtimeTasks = useStore((s) => s.runtimeTasks[threadId] ?? EMPTY_TASKS)
  const activeTasks = useMemo(() => runtimeTasks.filter(isRuntimeTaskActive), [runtimeTasks])
  const threads = useStore((s) => s.threads)
  const helperThreads = useMemo(() => Object.values(threads).filter((candidate) => candidate.parent_thread_id === threadId && candidate.status !== "archived"), [threadId, threads])
  const providers = useStore((s) => s.providers)
  const set = useStore((s) => s.set)
  const requestedEnvOpen = useStore((s) => s.envOpen)
  const envOpen = requestedEnvOpen && isFocused
  const composer = useRef<ComposerHandle>(null)
  const overlay = useRef<HTMLDivElement>(null)
  const [overlayHeight, setOverlayHeight] = useState(120)

  useEffect(() => {
    if (!loaded) void loadThread(threadId)
  }, [threadId, loaded])

  useEffect(() => {
    if (isFocused) composer.current?.focus()
  }, [threadId, isFocused])

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
  const hideInput = !!approval && isUserInput(approval) && !connector

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
  const canCompact = !!thread?.provider_session_id && (
    ["codex", "pi", "omp", "opencode"].includes(thread.provider.kind) || nativeCommands.some((command) => command.name === "compact")
  )
  const commands = useMemo<SlashCommand[]>(
    () => [
      { name: "resume", hint: "Continue a saved session", icon: <ClockIcon className="size-4" />, run: () => set({ sessionsOpen: true, sessionsProjectId: thread?.project_id ?? null }) },
      { name: "sessions", hint: "Browse saved sessions", icon: <ClockIcon className="size-4" />, run: () => set({ sessionsOpen: true, sessionsProjectId: thread?.project_id ?? null }) },
      ...(canCompact ? [{ name: "compact", hint: "Compact context and keep conversation history", icon: <WorkflowIcon className="size-4" />, run: () => {
        void rpc().call("threads.compact", { thread_id: threadId }).catch((error) => toast.error("Unable to compact context", { description: errorText(error) }))
      } }] : []),
      ...nativeCommands.filter((command) => command.name !== "compact").map((command) => ({
        name: ["resume", "sessions", "new", "stop", "activity", "attach", "changes", "terminal", "files", "environment", "pr", "archive", "settings", "usage"].includes(command.name) ? `harness:${command.name}` : command.name,
        invocation: command.name,
        hint: `${PROVIDER_LABEL[thread?.provider.kind ?? "codex"]} · ${command.description}`,
        insert: true, run: () => {},
      })),
      { name: "new", hint: "Start a new thread in this project", icon: <NewThreadIcon className="size-4" />, run: () => newThread(thread?.project_id) },
      { name: "reconnect", hint: "Release the idle agent; resume history on your next message", icon: <WorkflowIcon className="size-4" />, run: () => {
        void rpc().call("threads.release", { thread_id: threadId }).then(() => toast("Agent released", { description: "Your next message resumes the saved conversation." })).catch((error) => toast.error("Unable to release agent", { description: errorText(error) }))
      } },
      { name: "stop", hint: "Interrupt the running turn", icon: <StopIcon className="size-4" />, run: () => void interrupt(threadId) },
      { name: "activity", hint: "Show agents and background processes", icon: <WorkflowIcon className="size-4" />, run: () => set({ rightOpen: true, rightTab: "activity" }) },
      { name: "agents", hint: "Start and coordinate helper agents", icon: <UsersIcon className="size-4" />, run: () => set({ rightOpen: true, rightTab: "collaboration" }) },
      { name: "collaboration", hint: "Open Agents", icon: <UsersIcon className="size-4" />, run: () => set({ rightOpen: true, rightTab: "collaboration" }) },
      { name: "attach", hint: "Attach files or images", icon: <PaperclipIcon className="size-4" />, run: () => document.querySelector<HTMLInputElement>('input[type="file"]')?.click() },
      { name: "changes", hint: "Show the changes panel", icon: <ChangesIcon className="size-4" />, run: () => set({ rightOpen: true, rightTab: "changes" }) },
      { name: "terminal", hint: "Open a terminal in this thread", icon: <TerminalIcon className="size-4" />, run: () => set({ rightOpen: true, rightTab: "terminal" }) },
      { name: "files", hint: "Browse the project files", icon: <FoldersIcon className="size-4" />, run: () => set({ rightOpen: true, rightTab: "explorer" }) },
      { name: "environment", hint: "Show branch, commit and pull request controls", icon: <GitBranchIcon className="size-4" />, run: () => set({ rightOpen: true, rightTab: "changes" }) },
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
      ...(!thread?.coordinator_project_id ? [{ name: "archive", hint: "Archive this thread", icon: <ArchiveIcon className="size-4" />, run: () => void archiveThread(threadId) }] : []),
      { name: "settings", hint: "Open settings", icon: <SettingsIcon className="size-4" />, run: () => set({ settingsOpen: true, settingsTab: "general" }) },
      { name: "usage", hint: "Review token usage and cost", icon: <ClockIcon className="size-4" />, run: () => set({ settingsOpen: true, settingsTab: "usage" }) },
    ],
    [threadId, thread?.project_id, thread?.coordinator_project_id, thread?.provider, canCompact, nativeCommands, set],
  )

  if (!thread) return null

  const onSend = async (message: UserMessage) => {
    if (running) {
      await queueMessage(threadId, message)
      return
    }
    await sendMessage(threadId, message)
  }

  const onSteer = ["codex", "pi"].includes(thread.provider.kind) ? async (message: UserMessage) => {
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
      <Header threadId={threadId} splitPaneId={splitPaneId} showSidebarControls={showSidebarControls} />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className={cn("flex min-h-0 flex-1 flex-col", ENVIRONMENT_CONTENT_INSET_MOTION_CLASS)} style={{ paddingRight: envOpen ? ENVIRONMENT_DOCKED_CONTENT_INSET_PX : 0 }}>
          <Transcript threadId={threadId} bottomInset={overlayHeight} surfaceMode={splitPaneId ? "split" : "single"} />
        </div>
        <EnvironmentPanel threadId={threadId} open={envOpen} />
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
            <Composer
              className="thread-composer"
              showProviderUsage
              providerUsage={providerUsage}
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
              onModeChange={(m) => updateThread(threadId, { permission_mode: m }).catch((e) => toast.error("Unable to change mode", { description: errorText(e) }))}
              provider={thread.provider}
              providers={providers}
              onProviderChange={canSwitchCoordinator ? (provider) => switchCoordinatorHarness(provider) : undefined}
              model={thread.model}
              effort={thread.effort}
              surfaceMode={splitPaneId ? "split" : "single"}
              onModelChange={thread.coordinator_project_id
                ? canSwitchCoordinator
                  ? (model, effort) => switchCoordinatorHarness(thread.provider, model, effort)
                  : undefined
                : (model, effort) => updateThread(threadId, { model, effort })}
              projectId={thread.project_id}
              commands={commands}
              onDigit={(n) => answer(n)}
              above={
                <ComposerPanelStack closed={hideInput}>
                  {thread.coordinator_project_id && <CoordinatorControlsPanel key={thread.id} thread={thread} />}
                  {helperThreads.length > 0 && <HelperThreadsPanel threads={helperThreads} />}
                  {activeTasks.length > 0 && <RuntimeActivityPanel tasks={activeTasks} />}
                  {queued.length > 0 && <QueuedPanel threadId={threadId} />}
                  {!approval && questions[0] && <AsyncQuestionPanel key={questions[0].id} threadId={threadId} request={questions[0]} count={questions.length} />}
                  {approval && (
                    connector ? <ConnectorApprovalPanel key={approval.id} approval={approval} connector={connector} count={pending.length} onChoose={answer} /> : isUserInput(approval) ? <UserInputPanel key={approval.id} approval={approval} count={pending.length} /> : <ApprovalPanel key={approval.id} approval={approval} count={pending.length} onChoose={answer} />
                  )}
                </ComposerPanelStack>
              }
            />
          </div>
        </div>
      </div>
    </div>
  )
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
  const [open, setOpen] = useState(() => (working > 0 || approvals > 0) && threads.length <= 3)
  const summary = approvals > 0 ? `${approvals} ${approvals === 1 ? "needs" : "need"} approval` : working > 0 ? `${working} working` : null
  return (
    <ComposerStackedPanel>
      <ComposerStackedPanelRow compact className="gap-1">
        <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-start outline-hidden focus-visible:ring-1 focus-visible:ring-ring">
          <UsersIcon className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />
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
  const detail = foreground?.title ?? tasks[0]?.title
  return (
    <ComposerStackedPanel className="t-panel-enter">
      <ComposerStackedPanelRow>
        <ComposerStackedPanelRowMain>
          <WorkflowIcon className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />
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
  const updates = queued.filter(q => collaborationPreview(promptText(q.message)))
  const prompts = queued.filter(q => !collaborationPreview(promptText(q.message)))
  return <ComposerStackedPanel className="composer-queue-panel flex max-h-64 flex-col overflow-y-auto">
    {updates.length > 0 && <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}
      className="flex min-h-9 w-full items-center gap-2 px-3 py-2 text-start text-xs text-muted-foreground hover:text-foreground">
      <DisclosureChevron open={expanded} />
      <span>{updates.length} agent {updates.length === 1 ? "update" : "updates"} waiting</span>
    </button>}
    {prompts.length > 0 && <div className="px-3 pt-2 text-xs text-muted-foreground">Queued · {prompts.length}</div>}
    {queued.filter(q => expanded || !collaborationPreview(promptText(q.message))).map((q, i) => <QueuedRow key={q.id} item={{ ...q, thread_id: threadId }} divided={i > 0} />)}
  </ComposerStackedPanel>
}

function QueuedRow({ item, divided }: { item: import("@/protocol").QueuedMessage; divided: boolean }) {
  const [entered, setEntered] = useState(false)
  const preview = collaborationPreview(promptText(item.message))
  const sender = useStore(state => preview?.senderId ? state.threads[preview.senderId]?.title || "Helper" : "You")
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
          <span className="flex min-w-0 items-center gap-2"><span className={cn(COMPOSER_STACKED_PANEL_PREVIEW_MARKDOWN_CLASS_NAME, "min-w-0 flex-1")}>{preview ? `${preview.purpose} · ${sender}` : promptText(item.message) || "Queued follow-up"}</span><DisclosureChevron open={showBody} /></span>
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
    <ComposerStackedPanel className="composer-approval-panel t-border-beam t-panel-enter px-3.5 py-3">
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
      <div className="mt-2.5 space-y-0.5">
        <ComposerChoiceRow shortcut={1} label={approval.tool_name === "ExitPlanMode" ? "Start implementing" : "Approve once"} description={approval.tool_name === "ExitPlanMode" ? "Continue with the proposed plan" : "Allow just this request"} tone="primary" onSelect={() => onChoose(1)} />
        {approval.tool_name !== "ExitPlanMode" && <ComposerChoiceRow shortcut={2} label="Always allow this session" description="Don't ask again this session" onSelect={() => onChoose(2)} />}
        <ComposerChoiceRow shortcut={3} label="Decline" description="Reject and let the agent continue" tone="destructive" onSelect={() => onChoose(3)} />
        <ComposerChoiceRow shortcut={4} label="Cancel turn" description="Stop the current turn" onSelect={() => onChoose(4)} />
      </div>
    </ComposerStackedPanel>
  )
}

/** Consent for a harness to drive an app on this machine. Same card as other approvals, so the digits work the same. */
export function ConnectorApprovalPanel({ approval, connector, count, onChoose }: { approval: ApprovalRequest; connector: ConnectorApproval; count: number; onChoose: (n: number) => void }) {
  const canPersist = connector.persist.includes("session")
  const prompt = connector.app ? `Allow ${connector.connector} to use ${connector.app}?` : connector.message || `Allow ${connector.connector}?`
  return (
    <ComposerStackedPanel className="composer-approval-panel t-border-beam t-panel-enter px-3.5 py-3">
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
      <div className="mt-2.5 space-y-0.5">
        {canPersist && <ComposerChoiceRow shortcut={1} label="Allow this session" description={connector.app ? `Don’t ask again for ${connector.app} in this thread` : "Don’t ask again in this thread"} tone="primary" onSelect={() => onChoose(1)} />}
        <ComposerChoiceRow shortcut={canPersist ? 2 : 1} label="Allow once" description="Ask again before the next action" tone={canPersist ? "neutral" : "primary"} onSelect={() => onChoose(canPersist ? 2 : 1)} />
        <ComposerChoiceRow shortcut={3} label="Don’t allow" description="Refuse and let the agent continue" tone="destructive" onSelect={() => onChoose(3)} />
        <ComposerChoiceRow shortcut={4} label="Cancel turn" description="Stop the current turn" onSelect={() => onChoose(4)} />
      </div>
    </ComposerStackedPanel>
  )
}

function Header({ threadId, splitPaneId, showSidebarControls }: { threadId: ThreadId; splitPaneId?: PaneId; showSidebarControls: boolean }) {
  const [deleting, setDeleting] = useState(false)
  const thread = useStore((s) => s.threads[threadId])
  const threads = useStore((s) => s.threads)
  const mainThread = useMemo(() => {
    if (!thread?.parent_thread_id) return undefined
    const seen = new Set<ThreadId>([thread.id])
    let current = thread
    while (current.parent_thread_id && !seen.has(current.parent_thread_id)) {
      const parent = threads[current.parent_thread_id]
      if (!parent) break
      seen.add(parent.id)
      current = parent
    }
    return current.id === thread.id ? undefined : current
  }, [thread, threads])
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
      showSidebarControls={showSidebarControls}
      trailing={
        <>
      {deleting && thread && <DeleteCoordinatorDialog thread={thread} onClose={() => setDeleting(false)} />}
          {others.length > 0 && (
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
            <ComposerPickerMenuPopup align="end" side="bottom" className="w-56 min-w-56">
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
              {!thread.coordinator_project_id && (
                <>
                  <MenuSeparator />
                  <MenuGroup>
                    <MenuItem variant="destructive" onClick={() => thread.coordinator_project_id ? setDeleting(true) : void archiveThread(threadId).catch((error) => toast.error(errorText(error)))}>
                      <ArchiveIcon /> {thread.coordinator_project_id ? "Delete coordinator" : "Archive"}
                    </MenuItem>
                  </MenuGroup>
                </>
              )}
            </ComposerPickerMenuPopup>
          </Menu>
        </>
      }
    >
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
    </SurfaceHeader>
  )
}
