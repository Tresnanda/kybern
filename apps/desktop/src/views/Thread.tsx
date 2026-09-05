import { Markdown } from "@/components/kybern/Markdown"
import { connectorApproval, connectorApprovalResponse, isUserInput, type ConnectorApproval } from "@/lib/userInput"
import { UserInputPanel } from "./UserInputPanel"
// Thread route: Synara-style header (provider glyph, title, Hand off,
// actions, dock toggle), the transcript scrolling under the frosted composer,
// queued follow-ups stacked above the input and the approval card.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import { ProviderMark } from "@/components/kybern/bits"
import { Button } from "@/components/synara/button"
import { IconButton } from "@/components/synara/icon-button"
import { ComposerChoiceRow } from "@/components/synara/chat/ComposerChoiceRow"
import { ComposerPickerMenuPopup } from "@/components/synara/chat/ComposerPickerMenuPopup"
import { ComposerStackedPanel, COMPOSER_STACKED_PANEL_DIVIDER_CLASS_NAME } from "@/components/synara/chat/ComposerStackedPanel"
import { ComposerStackedPanelRow, ComposerStackedPanelRowMain } from "@/components/synara/chat/ComposerStackedPanelContent"
import { Menu, MenuGroup, MenuItem, MenuSeparator, MenuShortcut, MenuTrigger } from "@/components/synara/menu"
import { PROVIDER_LABEL, basename, mod, toolLine } from "@/lib/format"
import { activeTaskSummary } from "@/lib/runtimeActivity"
import {
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
  XIcon,
} from "@/lib/synara/icons"
import { COMPOSER_STACKED_PANEL_ICON_CLASS_NAME, COMPOSER_STACKED_PANEL_PREVIEW_MARKDOWN_CLASS_NAME } from "@/components/synara/chat/composerStackedPanelStyles"
import { openExternal } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import type { ApprovalRequest, JsonValue, RuntimeTask, ThreadId, UserMessage } from "@/protocol"
import { newThread } from "@/state/nav"
import { archiveThread, errorText, interrupt, loadThread, respondApproval, rpc, sendMessage, queueMessage, removeQueuedMessage, updateThread } from "@/state/rpc"
import { canSplitPane, type PaneId } from "@/state/splitView"
import { isRuntimeTaskActive, useStore } from "@/state/store"

import { ENVIRONMENT_CONTENT_INSET_MOTION_CLASS } from "@/components/synara/chat/composerPickerStyles"

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
  const thread = useStore((s) => s.threads[threadId])
  const loaded = useStore((s) => s.transcripts[threadId]?.loaded)
  const pending = useStore((s) => s.transcripts[threadId]?.pendingApprovals ?? EMPTY)
  const queued = useStore((s) => s.queued[threadId] ?? EMPTY)
  const runtimeTasks = useStore((s) => s.runtimeTasks[threadId] ?? EMPTY_TASKS)
  const activeTasks = useMemo(() => runtimeTasks.filter(isRuntimeTaskActive), [runtimeTasks])
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
    const ro = new ResizeObserver(([entry]) => setOverlayHeight(Math.round(entry?.contentRect.height ?? 0)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const running = thread?.status === "running" || thread?.status === "awaiting-approval"
  const approval = pending[0] ?? null
  const connector = approval ? connectorApproval(approval) : null

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
      if (!["1", "2", "3", "4"].includes(e.key) || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return
      if (answer(Number(e.key))) e.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approval?.id, isFocused])

  const commands = useMemo<SlashCommand[]>(
    () => [
      { name: "new", hint: "Start a new thread in this project", icon: <NewThreadIcon className="size-4" />, run: () => newThread(thread?.project_id) },
      { name: "stop", hint: "Interrupt the running turn", icon: <StopIcon className="size-4" />, run: () => void interrupt(threadId) },
      { name: "activity", hint: "Show agents and background processes", icon: <WorkflowIcon className="size-4" />, run: () => set({ rightOpen: true, rightTab: "activity" }) },
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
      { name: "archive", hint: "Archive this thread", icon: <ArchiveIcon className="size-4" />, run: () => void archiveThread(threadId) },
      { name: "settings", hint: "Open settings", icon: <SettingsIcon className="size-4" />, run: () => set({ settingsOpen: true, settingsTab: "general" }) },
      { name: "usage", hint: "Review token usage and cost", icon: <ClockIcon className="size-4" />, run: () => set({ settingsOpen: true, settingsTab: "usage" }) },
    ],
    [threadId, thread?.project_id, set],
  )

  if (!thread) return null

  const onSend = async (message: UserMessage) => {
    if (running) {
      await queueMessage(threadId, message)
      return
    }
    await sendMessage(threadId, message)
  }

  const placeholder = approval ? (isUserInput(approval) && !connector ? "Answer the questions above" : "Resolve this approval request to continue") : running ? "Ask for follow-up changes" : undefined

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
          className={cn("pointer-events-none absolute inset-x-0 bottom-0 z-10 pb-3 sm:pb-4", CHAT_COLUMN_GUTTER, ENVIRONMENT_CONTENT_INSET_MOTION_CLASS)}
          style={{
            paddingRight: envOpen
              ? `calc(${ENVIRONMENT_DOCKED_CONTENT_INSET_PX}px + var(--thread-chat-gutter, ${CHAT_COLUMN_GUTTER_PX}px))`
              : undefined,
          }}
        >
          <div className="pointer-events-auto">
            <Composer
              draftKey={`thread:${threadId}`}
              ref={composer}
              placeholder={placeholder}
              running={running}
              hideFooter={!!approval}
              hideInput={!!approval && isUserInput(approval) && !connector}
              onStop={() => void interrupt(threadId)}
              onSend={onSend}
              mode={thread.permission_mode}
              onModeChange={(m) => updateThread(threadId, { permission_mode: m }).catch((e) => toast.error("Unable to change mode", { description: errorText(e) }))}
              provider={thread.provider}
              providers={providers}
              model={thread.model}
              effort={thread.effort}
              surfaceMode={splitPaneId ? "split" : "single"}
              onModelChange={(model, effort) => updateThread(threadId, { model, effort }).catch((e) => toast.error("Unable to change model", { description: errorText(e) }))}
              projectId={thread.project_id}
              commands={commands}
              onDigit={(n) => answer(n)}
              above={
                <>
                  {activeTasks.length > 0 && <RuntimeActivityPanel tasks={activeTasks} />}
                  {queued.length > 0 && <QueuedPanel threadId={threadId} onEdit={(t) => composer.current?.setText(t)} />}
                  {approval && (
                    <div className="pb-2">
                      {connector ? <ConnectorApprovalPanel approval={approval} connector={connector} count={pending.length} onChoose={answer} /> : isUserInput(approval) ? <UserInputPanel key={approval.id} approval={approval} count={pending.length} /> : <ApprovalPanel approval={approval} count={pending.length} onChoose={answer} />}
                    </div>
                  )}
                </>
              }
            />
          </div>
        </div>
      </div>
    </div>
  )
}

function RuntimeActivityPanel({ tasks }: { tasks: RuntimeTask[] }) {
  const set = useStore((state) => state.set)
  const foreground = tasks.find((task) => !task.backgrounded)
  const detail = foreground?.title ?? tasks[0]?.title
  return (
    <ComposerStackedPanel>
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

function messageText(m: UserMessage): string {
  return m.parts
    .filter((p): p is Extract<UserMessage["parts"][number], { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n")
}

function QueuedPanel({ threadId, onEdit }: { threadId: ThreadId; onEdit: (text: string) => void }) {
  const queued = useStore((s) => s.queued[threadId] ?? EMPTY)
  const connected = useStore((s) => s.connection.state === "open")
  const remove = async (id: string, edit?: string) => {
    try {
      await removeQueuedMessage(threadId, id)
      if (edit !== undefined) onEdit(edit)
    } catch (error) { toast.error("Unable to remove follow-up", { description: errorText(error) }) }
  }
  return (
    <ComposerStackedPanel className="flex flex-col">
      {queued.map((q, i) => {
        const text = messageText(q.message) || "Queued follow-up"
        return (
          <ComposerStackedPanelRow key={q.id} compact data-testid="queued-follow-up-row" className={cn(i > 0 && COMPOSER_STACKED_PANEL_DIVIDER_CLASS_NAME)}>
            <ComposerStackedPanelRowMain>
              <SteerIcon className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />
              <span className={COMPOSER_STACKED_PANEL_PREVIEW_MARKDOWN_CLASS_NAME}>{text}</span>
            </ComposerStackedPanelRowMain>
            <div className="flex shrink-0 items-center gap-0">
              <Button
                variant="subtle"
                size="chip"
                disabled={!connected}
                onClick={() => void remove(q.id, text)}
              >
                <PencilIcon /> Edit
              </Button>
              <IconButton variant="ghost" size="icon-chip" label="Delete queued follow-up" tooltip="Remove" disabled={!connected} onClick={() => void remove(q.id)}>
                <Trash2 />
              </IconButton>
            </div>
          </ComposerStackedPanelRow>
        )
      })}
    </ComposerStackedPanel>
  )
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
    <div className="chat-composer-surface overflow-hidden border border-[color:var(--surface-border)] px-3.5 py-3 shadow-[0_4px_18px_-6px_color-mix(in_srgb,var(--foreground)_7%,transparent)] transition-colors duration-200 dark:shadow-[0_6px_24px_-10px_rgba(0,0,0,0.30)]">
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
    </div>
  )
}

/** Consent for a harness to drive an app on this machine. Same card as other approvals, so the digits work the same. */
export function ConnectorApprovalPanel({ approval, connector, count, onChoose }: { approval: ApprovalRequest; connector: ConnectorApproval; count: number; onChoose: (n: number) => void }) {
  const canPersist = connector.persist.includes("session")
  const prompt = connector.app ? `Allow ${connector.connector} to use ${connector.app}?` : connector.message || `Allow ${connector.connector}?`
  return (
    <div className="chat-composer-surface overflow-hidden border border-[color:var(--surface-border)] px-3.5 py-3 shadow-[0_4px_18px_-6px_color-mix(in_srgb,var(--foreground)_7%,transparent)] transition-colors duration-200 dark:shadow-[0_6px_24px_-10px_rgba(0,0,0,0.30)]">
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
    </div>
  )
}

function Header({ threadId, splitPaneId, showSidebarControls }: { threadId: ThreadId; splitPaneId?: PaneId; showSidebarControls: boolean }) {
  const thread = useStore((s) => s.threads[threadId])
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
              <MenuSeparator />
              <MenuGroup>
                <MenuItem variant="destructive" onClick={() => archiveThread(threadId)}>
                  <ArchiveIcon /> Archive
                </MenuItem>
              </MenuGroup>
            </ComposerPickerMenuPopup>
          </Menu>
        </>
      }
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-2">
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
                {thread.title || "Untitled"}
              </h2>
            )}
          </div>
        </div>
      </div>
    </SurfaceHeader>
  )
}
