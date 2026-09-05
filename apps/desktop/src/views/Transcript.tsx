import { ImageThreadContext } from "@/lib/imageThread"
import { ResponseImage } from "@/components/kybern/ResponseImage"
import { responseImages } from "@/lib/responseImages"
import { isUserInput } from "@/lib/userInput"
// Transcript pane, to Synara's ChatTranscriptPane / MessagesTimeline spec:
// centered 46rem column, user bubbles at 80% width, a cohesive live-work group,
// settled "Worked for" disclosure, markdown answers with a tiny action footer,
// and the "Edited N files" card.

import { memo, useCallback, useDeferredValue, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { toast } from "sonner"

import { FileDiffBody } from "@/components/kybern/DiffView"
import { CHAT_COLUMN_GUTTER } from "./chatLayout"
import { Markdown } from "@/components/kybern/Markdown"
import { parseUnifiedDiff, type FileDiff } from "@/lib/diff"
import { Spinner } from "@/components/kybern/bits"
import { DisclosureChevron } from "@/components/synara/DisclosureChevron"
import { DisclosureRegion } from "@/components/synara/DisclosureRegion"
import { DiffStatLabel } from "@/components/synara/chat/DiffStatLabel"
import { FileEntryIcon } from "@/components/synara/chat/FileEntryIcon"
import { MessageActionButton } from "@/components/synara/chat/MessageActionButton"
import { ReviewChangesButton } from "@/components/synara/chat/ReviewChangesButton"
import {
  getChatMessageFooterTextStyle,
  getChatTranscriptTextStyle,
} from "@/components/synara/chat/chatTypography"
import { clockTime, elapsedSince, outputText, plural, toolLine } from "@/lib/format"
import { isAgentLaunchTool, runtimeActivityPrompt, runtimeActivityResult, summarizeToolCalls, toolVisualKind, type ToolVisualKind } from "@/lib/toolActivity"
import { copyText, useSmoothStream, useTicker } from "@/lib/hooks"
import { MessageScroller } from "@/components/beui/message-scroller"
import {
  ArrowDownIcon,
  BotIcon,
  BrainIcon,
  ChangesIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CopyIcon,
  EyeIcon,
  GitHubIcon,
  GlobeIcon,
  HammerIcon,
  McpIcon,
  PanelRightCloseIcon,
  PencilIcon,
  SearchIcon,
  SkillCubeIcon,
  TerminalIcon,
  Undo2Icon,
  WebSearchIcon,
} from "@/lib/synara/icons"
import { cn } from "@/lib/utils"
import type { ContentPart, Diff, RuntimeTask, ThreadId } from "@/protocol"
import { errorText, loadFileDiff, revertTo } from "@/state/rpc"
import { diffKey, isRuntimeTaskActive, useStore } from "@/state/store"
import { buildWorkHierarchy, groupTurns, shouldRevealLiveText, type Block, type TurnGroup } from "@/state/transcript"

const TEXT = getChatTranscriptTextStyle()
const CHAT_FONT: CSSProperties = { fontSize: TEXT.fontSize }
const META = getChatMessageFooterTextStyle()
const EMPTY_RUNTIME_TASKS: RuntimeTask[] = []
// No horizontal inset: message edges sit exactly on the composer's edges.
const ROW = "mx-auto w-full min-w-0 max-w-[var(--app-chat-max-width,46rem)]"
const HOVER_REVEAL =
  "opacity-0 transition-opacity pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto"

type ToolBlock = Extract<Block, { kind: "tool" }>
type AgentActivityTarget =
  | { kind: "tool"; turnId: string; toolCallId: string }
  | { kind: "task"; turnId: string; taskId: string }
type AgentActivitySelection = AgentActivityTarget & { threadId: ThreadId }
type OpenAgentActivity = (target: AgentActivityTarget) => void
type AgentActivityEntry =
  | { kind: "tool"; block: ToolBlock }
  | { kind: "task"; task: RuntimeTask; navigable: boolean }

interface AgentActivityDetail {
  title: string
  summary: string | null
  metadata: string
  kind: RuntimeTask["kind"]
  prompt: string | null
  result: string | null
  resultPending: boolean
  failed: boolean
  entries: AgentActivityEntry[]
  tasksByToolCall: ReadonlyMap<string, RuntimeTask>
  childrenByParent: ReadonlyMap<string, ToolBlock[]>
}

interface SettledWorkPresentation {
  agentBlocks: Block[]
  disclosureBlocks: Block[]
  tasksByToolCall: ReadonlyMap<string, RuntimeTask>
  childrenByParent: ReadonlyMap<string, ToolBlock[]>
}

/** Formats a duration the way Synara's formatClockDuration does. */
function clockDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm ? `${h}h ${rm}m` : `${h}h`
}

function runtimeTaskStatusLabel(task: RuntimeTask): string {
  if (task.status === "pending") return "Starting"
  if (task.status === "running") return task.backgrounded ? "Running in background" : "Running"
  if (task.status === "waiting") return task.backgrounded ? "Monitoring in background" : "Waiting"
  if (task.status === "stopping") return "Stopping"
  if (task.status === "completed") return "Completed"
  if (task.status === "failed") return "Failed"
  if (task.status === "stopped") return "Stopped"
  return "Interrupted"
}

function isAgentLaunchBlock(block: ToolBlock, task?: RuntimeTask): boolean {
  return task?.kind === "agent" || isAgentLaunchTool(block.call)
}

function settledWorkPresentation(blocks: readonly Block[], tasks: readonly RuntimeTask[]): SettledWorkPresentation {
  const tasksByToolCall = new Map(tasks.flatMap((task) => (task.tool_call_id ? [[task.tool_call_id, task] as const] : [])))
  const hierarchy = buildWorkHierarchy(blocks)
  const agentBlocks: Block[] = []
  const disclosureBlocks: Block[] = []
  for (const block of hierarchy.roots) {
    if (
      (block.kind === "tool" && isAgentLaunchBlock(block, tasksByToolCall.get(block.call.id))) ||
      (block.kind === "runtime_task" && block.task.kind === "agent")
    ) agentBlocks.push(block)
    else disclosureBlocks.push(block)
  }

  return {
    agentBlocks,
    disclosureBlocks,
    tasksByToolCall,
    childrenByParent: hierarchy.childrenByParent,
  }
}

function resolveAgentActivityDetail(groups: readonly TurnGroup[], tasks: readonly RuntimeTask[], target: AgentActivitySelection): AgentActivityDetail | null {
  const task = target.kind === "task"
    ? tasks.find((candidate) => candidate.id === target.taskId)
    : tasks.find((candidate) => candidate.origin_turn_id === target.turnId && candidate.tool_call_id === target.toolCallId)
  const group = groups.find((candidate) => candidate.turnId === target.turnId)
  const toolCallId = target.kind === "tool" ? target.toolCallId : task?.tool_call_id
  const block = toolCallId
    ? group?.work.find((candidate): candidate is ToolBlock => candidate.kind === "tool" && candidate.call.id === toolCallId)
    : undefined
  if (!task && !block) return null

  const hierarchy = buildWorkHierarchy(group?.work ?? [])
  const childBlocks = [
    ...(block ? (hierarchy.childrenByParent.get(block.call.id) ?? []) : []),
    ...(task ? (hierarchy.agentOwnedByTask.get(task.id) ?? []) : []),
  ].filter((candidate, index, all) => all.findIndex((other) => other.id === candidate.id) === index)
  const representedToolCalls = new Set(childBlocks.map((child) => child.call.id))
  const childTasks = task
    ? tasks.filter((candidate) => candidate.parent_id === task.id && (!candidate.tool_call_id || !representedToolCalls.has(candidate.tool_call_id)))
    : []
  const entries: AgentActivityEntry[] = [
    ...childBlocks.map((child): AgentActivityEntry => ({ kind: "tool", block: child })),
    ...childTasks.map((child): AgentActivityEntry => ({ kind: "task", task: child, navigable: true })),
    ...(task ? [{ kind: "task", task, navigable: false } satisfies AgentActivityEntry] : []),
  ].sort((a, b) => {
    const leftSeq = a.kind === "tool" ? a.block.seq : a.task.started_seq
    const rightSeq = b.kind === "tool" ? b.block.seq : b.task.started_seq
    if (leftSeq > 0 && rightSeq > 0 && leftSeq !== rightSeq) return leftSeq - rightSeq
    const left = Date.parse(a.kind === "tool" ? a.block.at : a.task.started_at)
    const right = Date.parse(b.kind === "tool" ? b.block.at : b.task.started_at)
    return (Number.isFinite(left) ? left : 0) - (Number.isFinite(right) ? right : 0)
  })
  const activity = block ? toolLine(block.call, block.complete && !(task && isRuntimeTaskActive(task))) : null
  const kind = task?.kind ?? "agent"
  const fallbackTitle = kind === "process" ? "Background process" : kind === "monitor" ? "Monitor" : "Delegated task"
  const title = task?.title || activity?.detail || fallbackTitle
  const summary = task?.detail && task.detail.trim() !== title.trim() ? task.detail : null
  const status = task ? runtimeTaskStatusLabel(task) : block?.isError ? "Failed" : block?.complete ? "Completed" : "Working"
  const metadata = [status, task?.model, task?.backgrounded ? "Background" : null].filter((value): value is string => !!value).join(" · ")
  const tasksByToolCall = new Map(tasks.flatMap((candidate) => (candidate.tool_call_id ? [[candidate.tool_call_id, candidate] as const] : [])))

  return {
    title,
    summary,
    metadata,
    kind,
    prompt: block ? runtimeActivityPrompt(block.call) : null,
    result: block ? runtimeActivityResult(block.output, block.stream) : null,
    resultPending: block ? !block.complete || !!(task && isRuntimeTaskActive(task)) : !!(task && isRuntimeTaskActive(task)),
    failed: block?.isError || task?.status === "failed",
    entries,
    tasksByToolCall,
    childrenByParent: hierarchy.childrenByParent,
  }
}

export function Transcript({
  threadId,
  bottomInset,
  surfaceMode = "single",
}: {
  threadId: ThreadId
  bottomInset: number
  surfaceMode?: "single" | "split"
}) {
  const state = useStore((s) => s.transcripts[threadId])
  const runtimeTasks = useStore((s) => s.runtimeTasks[threadId] ?? EMPTY_RUNTIME_TASKS)
  const blocks = state?.blocks
  const groups = useMemo(() => groupTurns(blocks ?? []), [blocks])
  const [agentActivityTrail, setAgentActivityTrail] = useState<AgentActivitySelection[]>([])
  const selectedActivity = agentActivityTrail.at(-1)
  const agentActivityDetail = useMemo(
    () => selectedActivity?.threadId === threadId ? resolveAgentActivityDetail(groups, runtimeTasks, selectedActivity) : null,
    [groups, runtimeTasks, selectedActivity, threadId],
  )
  const openAgentActivity = useCallback<OpenAgentActivity>((target) => {
    const selection: AgentActivitySelection = { ...target, threadId }
    setAgentActivityTrail((current) => current.at(-1)?.threadId === threadId ? [...current, selection] : [selection])
  }, [threadId])
  const closeAgentActivity = useCallback(() => {
    setAgentActivityTrail((current) => current.at(-1)?.threadId === threadId ? current.slice(0, -1) : [])
  }, [threadId])
  let latestUserMessageId: string | null = null
  for (let i = groups.length - 1; i >= 0; i--) {
    const user = groups[i]?.user
    if (user) {
      latestUserMessageId = user.id
      break
    }
  }
  const viewport = useRef<HTMLElement>(null)
  const [following, setFollowing] = useState(true)
  const busy = groups.some((g) => g.running)
  const scrollToBottom = () => {
    setFollowing(true)
    viewport.current?.scrollTo({ top: viewport.current.scrollHeight, behavior: "smooth" })
  }

  if (!state?.loaded) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center text-foreground [contain:layout_style_paint]">
        <div className="opacity-0 [animation:chat-mount-loader-in_200ms_ease-out_150ms_forwards] motion-reduce:animate-none motion-reduce:opacity-100">
          <Spinner size={20} className="text-muted-foreground" />
        </div>
      </div>
    )
  }

  return (
    <ImageThreadContext value={threadId}><div data-chat-transcript-pane className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div
        aria-hidden={agentActivityDetail ? true : undefined}
        inert={agentActivityDetail ? true : undefined}
        className={cn(
          "relative flex min-h-0 flex-1 flex-col overflow-hidden transition-opacity duration-150 ease-out motion-reduce:transition-none",
          agentActivityDetail && "pointer-events-none opacity-0",
        )}
      >
        <MessageScroller
          navigation={surfaceMode === "split" ? undefined : "rail"}
          navigationLabel="Message navigation"
          navigationSide="left"
          followOutput
          followKey={latestUserMessageId}
          followThreshold={56}
          onFollowChange={setFollowing}
          busy={busy}
          viewportRef={viewport}
          className="h-full min-h-0"
          style={{ "--rail-bottom": `${bottomInset + 24}px` } as CSSProperties}
          railClassName="!top-3 !bottom-[var(--rail-bottom)] text-muted-foreground/70"
          viewportClassName={cn("scroll-fade-b h-full overflow-x-hidden overscroll-y-contain py-3 sm:py-4 focus-visible:ring-0", CHAT_COLUMN_GUTTER)}
          viewportProps={{ "data-chat-scroll-container": "" } as Record<string, unknown>}
          contentProps={{ style: { paddingBottom: bottomInset + 64 } }}
        >
          {groups.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-muted-foreground/30">Send a message to start the conversation.</p>
            </div>
          ) : (
            groups.map((g, i) => <Turn key={g.turnId || i} group={g} threadId={threadId} isLast={i === groups.length - 1} onOpenAgentActivity={openAgentActivity} />)
          )}
        </MessageScroller>
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 z-30 flex justify-center py-1 transition-[opacity,transform] duration-220 ease-out motion-reduce:transition-none",
            !following ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0",
          )}
          style={{ bottom: bottomInset + 24 }}
        >
          <button
            type="button"
            aria-label="Scroll to bottom"
            onClick={() => scrollToBottom()}
            className={cn(
              "flex size-8 items-center justify-center rounded-full border border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] text-[var(--color-text-foreground)] backdrop-blur-md transition-colors hover:cursor-pointer hover:bg-[var(--color-background-elevated-secondary)]",
              !following ? "pointer-events-auto" : "pointer-events-none",
            )}
          >
            <ArrowDownIcon className="size-3.5" />
          </button>
        </div>
      </div>
      {agentActivityDetail && (
        <AgentActivityDetailView detail={agentActivityDetail} bottomInset={bottomInset} onBack={closeAgentActivity} onOpenAgentActivity={openAgentActivity} />
      )}
    </div></ImageThreadContext>
  )
}

function AgentActivityDetailView({ detail, bottomInset, onBack, onOpenAgentActivity }: { detail: AgentActivityDetail; bottomInset: number; onBack: () => void; onOpenAgentActivity: OpenAgentActivity }) {
  const promptTitle = detail.kind === "process" ? "Command" : detail.kind === "monitor" ? "Request" : "Prompt"
  const resultTitle = detail.kind === "process" ? "Output" : "Result"
  const missingPrompt = detail.kind === "process" ? "The command was not exposed by this harness." : "The delegated prompt was not exposed by this harness."
  const missingResult = detail.resultPending
    ? detail.kind === "agent" ? "The agent is still working." : "This work is still running."
    : detail.failed ? "No additional error details were reported." : "This harness did not expose a final result."

  return (
    <div
      data-agent-activity-detail="true"
      data-chat-scroll-container="true"
      className={cn("runtime-activity-detail-enter absolute inset-0 z-20 overflow-x-hidden overflow-y-auto overscroll-y-contain bg-background py-3 [scrollbar-gutter:stable] sm:py-4", CHAT_COLUMN_GUTTER)}
      style={{ paddingBottom: bottomInset + 64 }}
    >
      <div className={ROW}>
        <button
          type="button"
          data-scroll-anchor-ignore
          onClick={onBack}
          className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 font-system-ui text-muted-foreground/70 transition-colors duration-150 hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          style={META}
        >
          <ChevronLeftIcon className="size-3.5" />
          <span>Back</span>
        </button>

        <header className="mt-3 border-b border-border/55 pb-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-border/45 bg-background/65 text-muted-foreground/60">
              {detail.kind === "process" ? <TerminalIcon className="size-3.5" /> : <BotIcon className="size-3.5" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h2 className="min-w-0 truncate font-system-ui text-[18px] leading-6 font-medium text-foreground/92">{detail.title}</h2>
                <span className="shrink-0 rounded-full border border-border/45 px-2 py-0.5 font-system-ui text-[10px] font-medium text-muted-foreground/56">
                  {plural(detail.entries.length, "update")}
                </span>
              </div>
              <p className="mt-1 font-system-ui text-muted-foreground/58" style={CHAT_FONT} aria-live="polite">{detail.metadata}</p>
              {detail.summary && <p className="mt-1 max-w-3xl text-muted-foreground/68" style={CHAT_FONT}>{detail.summary}</p>}
            </div>
          </div>
        </header>

        <AgentActivitySection title={promptTitle}>
          {detail.prompt ? <Markdown text={detail.prompt} style={TEXT} /> : <AgentActivityEmpty>{missingPrompt}</AgentActivityEmpty>}
        </AgentActivitySection>
        <AgentActivitySection title={resultTitle}>
          {detail.result ? (
            <div className={cn(detail.failed && "text-destructive/90")}><Markdown text={detail.result} style={TEXT} /></div>
          ) : <AgentActivityEmpty>{missingResult}</AgentActivityEmpty>}
        </AgentActivitySection>
        <AgentActivitySection title="Activity">
          <AgentActivityEntries entries={detail.entries} tasksByToolCall={detail.tasksByToolCall} childrenByParent={detail.childrenByParent} onOpenAgentActivity={onOpenAgentActivity} />
        </AgentActivitySection>
      </div>
    </div>
  )
}

function AgentActivitySection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-border/45 py-4 last:border-b-0">
      <h3 className="mb-2 font-system-ui text-[11px] font-medium text-muted-foreground/48">{title}</h3>
      {children}
    </section>
  )
}

function AgentActivityEmpty({ children }: { children: ReactNode }) {
  return <p className="font-system-ui text-muted-foreground/52" style={CHAT_FONT}>{children}</p>
}

function AgentActivityEntries({ entries, tasksByToolCall, childrenByParent, onOpenAgentActivity }: { entries: readonly AgentActivityEntry[]; tasksByToolCall: ReadonlyMap<string, RuntimeTask>; childrenByParent: ReadonlyMap<string, ToolBlock[]>; onOpenAgentActivity: OpenAgentActivity }) {
  if (entries.length === 0) return <AgentActivityEmpty>No child activity was reported.</AgentActivityEmpty>
  return (
    <div className="divide-y divide-border/45">
      {entries.map((entry) => entry.kind === "tool" ? (
        <div key={entry.block.id} className="py-2 first:pt-0 last:pb-0">
          <ToolRow block={entry.block} task={tasksByToolCall.get(entry.block.call.id)} tasksByToolCall={tasksByToolCall} childrenByParent={childrenByParent} onOpenAgentActivity={onOpenAgentActivity} showTimestamp />
        </div>
      ) : (
        <RuntimeTaskActivityEntry key={entry.task.id} task={entry.task} navigable={entry.navigable} onOpenAgentActivity={onOpenAgentActivity} />
      ))}
    </div>
  )
}

function RuntimeTaskActivityEntry({ task, navigable, onOpenAgentActivity }: { task: RuntimeTask; navigable: boolean; onOpenAgentActivity: OpenAgentActivity }) {
  const noun = task.kind === "agent" ? "Agent" : task.kind === "process" ? "Process" : "Monitor"
  const detail = task.detail || (task.last_tool_name ? `Using ${task.last_tool_name}` : null)
  const body = (
    <>
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
        {task.kind === "process" ? <TerminalIcon className="size-3.5" /> : <BotIcon className="size-3.5" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate leading-6 text-muted-foreground transition-colors group-hover/tool-row:text-foreground" style={CHAT_FONT}>
          {noun} {runtimeTaskStatusLabel(task).toLowerCase()}{navigable ? ` · ${task.title}` : ""}
        </p>
        {detail && <p className="truncate font-system-ui text-[11px] leading-4 text-muted-foreground/52">{detail}</p>}
      </div>
      <time dateTime={task.updated_at} className="shrink-0 font-system-ui text-[11px] tabular-nums text-muted-foreground/38">{clockTime(task.updated_at)}</time>
      {navigable && <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/55 transition-colors group-hover/tool-row:text-foreground" />}
    </>
  )
  if (!navigable) return <div className="group/tool-row flex min-w-0 items-center gap-1.5 py-3 first:pt-0 last:pb-0">{body}</div>
  return (
    <button type="button" onClick={() => onOpenAgentActivity({ kind: "task", turnId: task.origin_turn_id, taskId: task.id })} className="group/tool-row flex w-full min-w-0 cursor-pointer items-center gap-1.5 py-3 text-start first:pt-0 last:pb-0 focus-visible:outline-none">
      {body}
    </button>
  )
}

const Turn = memo(function Turn({ group, threadId, isLast, onOpenAgentActivity }: { group: TurnGroup; threadId: ThreadId; isLast: boolean; onOpenAgentActivity: OpenAgentActivity }) {
  const images = [...group.images.map((image) => ({ source: image.source, label: "Agent image" })), ...group.work.flatMap((block) => block.kind === "tool" && block.origin.kind === "root" ? responseImages(block.output) : [])].filter((image, index, all) => all.findIndex((other) => other.source === image.source) === index)
  const expanded = useStore((s) => s.expandedWork[group.turnId])
  const toggle = useStore((s) => s.toggleWork)
  const diff = useStore((s) => s.diffs[diffKey(threadId, group.turnId)])
  const runtimeTasks = useStore((s) => s.runtimeTasks[threadId] ?? EMPTY_RUNTIME_TASKS)
  const launchedTasks = useMemo(
    () => runtimeTasks.filter((task) => task.origin_turn_id === group.turnId),
    [group.turnId, runtimeTasks],
  )
  const settledWork = useMemo(
    () => settledWorkPresentation(group.work, launchedTasks),
    [group.work, launchedTasks],
  )
  const hasWork = group.work.length > 0
  const hasPrimaryAgentActivity = settledWork.agentBlocks.length > 0
  const hasDisclosedWork = settledWork.disclosureBlocks.length > 0
  const hasSettledActivity = hasPrimaryAgentActivity || hasDisclosedWork
  const hasLiveWork =
    launchedTasks.some(isRuntimeTaskActive) ||
    group.work.some(
      (block) =>
        (block.kind === "tool" && !block.complete) ||
        (block.kind === "runtime_task" && isRuntimeTaskActive(block.task)) ||
        (block.kind === "assistant" && !block.complete && (!!block.thinking.trim() || shouldRevealLiveText(block.text, block.complete))) ||
        (block.kind === "approval" && !block.decision),
    )
  const settled = !group.running
  const open = group.running || !!expanded

  return (
    <>
      {group.user && (
        <div className={cn(ROW, group.running ? "pb-5" : "pb-4")} data-timeline-row-kind="message" data-message-role="user" data-slot="message" data-from="user">
          <UserBubble message={group.user.message} at={group.user.at} />
        </div>
      )}

      {group.running && (
        <div className={cn(ROW, "pb-2")} data-timeline-row-kind="live-work">
          <WorkingHeader since={group.user?.at ?? ""} />
          {hasWork && (
            <div className="mt-1 space-y-0.5" data-timeline-row-kind="work">
              {/* Every live event stays at its sequence position. Only the tail
                  assistant segment streams; earlier prose never gets reparented. */}
              <WorkList blocks={group.work} tasks={launchedTasks} tone="bright" liveTextId={group.liveTextId} onOpenAgentActivity={onOpenAgentActivity} />
            </div>
          )}
          {!hasLiveWork && (
            <div className="shimmer mt-1.5 font-system-ui text-muted-foreground" style={CHAT_FONT} data-timeline-row-kind="working">
              Thinking
            </div>
          )}
        </div>
      )}

      {images.length > 0 && <div className={ROW}>{images.map((image) => <ResponseImage key={image.source} source={image.source} label={image.label} />)}</div>}

      {settled && (
        <div className={cn(ROW, "group/assistant pb-2")} data-timeline-row-kind="message" data-message-role="assistant" data-slot="message" data-from="assistant">
          {hasSettledActivity && (
            // One work block: delegated agents stay visible (harness-parity), the
            // routine execution history folds under a "Worked for Ns" row that
            // shares the same gutter, then a hairline separates work from answer.
            <div className="mb-3 space-y-0.5" data-timeline-row-kind="settled-work">
              {hasPrimaryAgentActivity && (
                <div data-primary-agent-activity="true" className="space-y-0.5">
                  <WorkRows
                    blocks={settledWork.agentBlocks}
                    tasksByToolCall={settledWork.tasksByToolCall}
                    childrenByParent={settledWork.childrenByParent}
                    compact
                    onOpenAgentActivity={onOpenAgentActivity}
                  />
                </div>
              )}
              {hasDisclosedWork && (
                <div className="group/collapsed-work py-1">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => toggle(group.turnId)}
                    className="group/tool-row flex w-full cursor-pointer items-center gap-1.5 text-start focus-visible:outline-none"
                  >
                    <span data-work-entry-icon className={cn("flex size-4 shrink-0 items-center justify-center", TONE)}>
                      <HammerIcon className="size-3.5" />
                    </span>
                    <span className={cn("min-w-0 flex-1 truncate leading-6", TONE)} style={CHAT_FONT}>
                      {group.end ? `Worked for ${clockDuration(group.end.durationMs)}` : "Worked"}
                    </span>
                    <DisclosureChevron open={open} className="text-muted-foreground/65 group-hover/tool-row:text-foreground" />
                  </button>
                  <DisclosureRegion open={open} contentClassName="ms-5 mt-0.5 space-y-0.5 ps-0.5">
                    <WorkRows
                      blocks={settledWork.disclosureBlocks}
                      tasksByToolCall={settledWork.tasksByToolCall}
                      childrenByParent={settledWork.childrenByParent}
                      compact
                      onOpenAgentActivity={onOpenAgentActivity}
                    />
                  </DisclosureRegion>
                </div>
              )}
              <div className="mt-1 h-px w-full bg-border" />
            </div>
          )}

          <div className="group min-w-0 py-0.5">
            {group.answer && (
              <div data-slot="message-content">
                <Markdown text={group.answer.text} style={TEXT} />
              </div>
            )}

            {group.end?.error && (
              <p className="mt-2 flex items-start gap-2 text-destructive" style={TEXT}>
                <CircleAlertIcon className="mt-1 size-3.5 shrink-0" />
                <span className="selectable">{group.end.error}</span>
              </p>
            )}
            {group.end?.stopReason === "interrupted" && (
              <p className="text-muted-foreground" style={TEXT}>
                Stopped.
              </p>
            )}

            {diff && diff.files.length > 0 && <EditedFilesCard diff={diff} threadId={threadId} turnId={group.turnId} canUndo={isLast && settled} />}

            {group.reverted && (
              <p className="mt-2 flex items-center gap-1.5 text-muted-foreground" style={TEXT}>
                <Undo2Icon className="size-3" /> Reverted to before this turn
              </p>
            )}

            {settled && (group.answer || group.end) && (
              <div className="mt-0.5 flex items-center gap-2 font-system-ui font-normal text-muted-foreground [&>button:first-child]:-ml-[0.4375em]" style={META}>
                <CopyAction text={group.answer?.text ?? ""} />
                {group.end?.at && <p className="tabular-nums">{clockTime(group.end.at)}</p>}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
})

function RuntimeTaskTranscriptRow({ task, onOpenAgentActivity }: { task: RuntimeTask; onOpenAgentActivity: OpenAgentActivity }) {
  const set = useStore((state) => state.set)
  const active = isRuntimeTaskActive(task)
  const noun = task.kind === "agent" ? "agent" : task.kind === "process" ? "process" : "monitor"
  const status = active
    ? task.status === "waiting"
      ? "Monitoring"
      : task.status === "stopping"
        ? "Stopping"
        : "Active"
    : task.status === "failed"
      ? "Failed"
      : task.status === "stopped" || task.status === "interrupted"
        ? "Stopped"
        : "Completed"
  return (
    <button
      type="button"
      title={task.title}
      data-agent-launch-row={task.kind === "agent" ? "true" : undefined}
      onClick={() => {
        if (task.kind === "agent") {
          onOpenAgentActivity({ kind: "task", turnId: task.origin_turn_id, taskId: task.id })
          return
        }
        set({ rightOpen: true, rightTab: "activity" })
      }}
      className="group/task-row flex w-full cursor-pointer items-center gap-1.5 py-1 text-start focus-visible:outline-none"
    >
      <span className={cn("flex size-4 shrink-0 items-center justify-center", TONE)}>
        {task.kind === "process" ? <TerminalIcon className="size-3.5" /> : <BotIcon className="size-3.5" />}
      </span>
      <span className={cn("min-w-0 flex-1 truncate leading-6", TONE)} style={CHAT_FONT}>
        {task.kind === "agent" ? `${active ? "Delegating" : "Delegated"} ${task.title}` : `Started ${noun} · ${task.title}`}
      </span>
      <span className={cn("shrink-0 font-system-ui text-[11px] tabular-nums", task.status === "failed" ? "text-destructive" : "text-muted-foreground/55")}>{status}</span>
      {task.kind === "agent" && <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/55 transition-colors group-hover/task-row:text-foreground" />}
    </button>
  )
}

function WorkingHeader({ since }: { since: string }) {
  const now = useTicker(true)
  return (
    <div className="-ml-0.5 text-muted-foreground" style={CHAT_FONT}>
      Working for {clockDuration(elapsedSince(since, now))}
    </div>
  )
}

function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <MessageActionButton
      label="Copy message"
      tooltip="Copy to clipboard"
      disabled={!text}
      onClick={() => {
        void copyText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }}
    >
      {copied ? <CheckIcon className="size-[1.125em] text-success" /> : <CopyIcon className="size-[1.125em]" />}
    </MessageActionButton>
  )
}

function UserBubble({ message, at }: { message: { parts: ContentPart[] }; at: string }) {
  const text = message.parts
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n")
  const files = message.parts.filter((p) => p.type !== "text")
  // Decided once on mount: only a bubble that was sent just now plays the send animation.
  const [fresh] = useState(() => Date.now() - new Date(at).getTime() < 3000)
  return (
    <div className={cn("flex w-full justify-end", fresh && "chat-message-send-enter")}>
      <div className="group relative flex max-w-[80%] flex-col items-end gap-px">
          {files.length > 0 && (
            <div className="mb-1 flex max-w-[240px] flex-wrap justify-end gap-2 self-end">
              {files.map((p, i) =>
                p.type === "image" ? (
                  <img
                    key={i}
                    src={`data:${p.media_type};base64,${p.data}`}
                    alt=""
                    className="size-15 rounded-xl object-cover outline -outline-offset-1 outline-black/10 dark:outline-white/10"
                  />
                ) : (
                  <span
                    key={i}
                    className="inline-flex h-7 max-w-[16rem] min-w-0 items-center gap-1.5 rounded-full border border-[color:var(--color-border)] bg-[var(--composer-surface)] px-2 text-[length:var(--app-font-size-ui-sm,13px)] font-medium text-[var(--color-text-foreground)]"
                  >
                    {p.type === "skill" ? (
                      <SkillCubeIcon className="size-3.5 shrink-0 text-muted-foreground/90" />
                    ) : (
                      <FileEntryIcon
                        pathValue={p.type === "attachment" ? p.name : p.path}
                        kind="file"
                        mimeType={p.type === "attachment" ? p.media_type : undefined}
                        className="size-3.5"
                      />
                    )}
                    <span className="min-w-0 truncate">{p.type === "attachment" ? p.name : p.type === "skill" ? `$${p.name}` : p.path}</span>
                  </span>
                ),
              )}
            </div>
          )}
          {text && (
            <div data-slot="message-content" className="w-max max-w-full min-w-0 self-end rounded-[var(--radius-user-message)] border border-transparent bg-[var(--app-user-message-background)] px-3 py-1.5">
              <Markdown text={text} variant="user" style={TEXT} />
            </div>
          )}
          <div className="absolute top-full right-0 flex items-center justify-end gap-2 pt-1 pr-0.5 font-system-ui font-normal whitespace-nowrap text-muted-foreground/45" style={META}>
            <p className={cn("tabular-nums", HOVER_REVEAL)}>{clockTime(at)}</p>
            <div className={cn("flex items-center gap-2", HOVER_REVEAL)}>
              <CopyAction text={text} />
            </div>
          </div>
      </div>
    </div>
  )
}

function workIcon(kind: ToolVisualKind, isError: boolean) {
  if (isError && !["github", "web", "mcp", "skill"].includes(kind))
    return <CircleAlertIcon className="size-4 text-muted-foreground/50" />
  switch (kind) {
    case "github":
      return <GitHubIcon className="size-3.5" />
    case "web":
      return <GlobeIcon className="size-3.5" />
    case "mcp":
      return <McpIcon className="size-3.5" />
    case "skill":
      return <SkillCubeIcon className="size-3.5" />
    case "command":
      return <TerminalIcon className="size-3.5" />
    case "edit":
    case "write":
      return <PencilIcon className="size-3.5" />
    case "read":
      return <SearchIcon className="size-3.5" />
    case "search":
    case "list":
      return <SearchIcon className="size-3.5" />
    case "fetch":
      return <WebSearchIcon className="size-3.5" />
    case "image":
      return <EyeIcon className="size-3.5" />
    case "delegate":
      return <BotIcon className="size-3.5" />
    default:
      return <HammerIcon className="size-3.5" />
  }
}

function workLabel(
  { verb, detail, kind }: ReturnType<typeof toolLine>,
  name: string,
  complete: boolean,
  isError = false,
): string {
  if (isError) {
    if (kind === "other") return detail ? `Failed to use ${detail}` : `Tool call failed`
    const action =
      kind === "command"
        ? "run a command"
        : kind === "read"
          ? "read"
          : kind === "search"
            ? "search"
            : kind === "list"
              ? "list"
              : kind === "write"
                ? "write"
                : kind === "edit"
                  ? "edit"
                  : kind === "fetch"
                    ? "fetch"
                    : kind === "delegate"
                      ? "delegate"
                      : "use the tool"
    return detail ? `Failed to ${action} ${detail}` : `Failed to ${action}`
  }
  if (kind === "command" && !detail)
    return complete ? "Ran a command" : "Running a command"
  if (kind === "read" && !detail)
    return complete ? "Read a file" : "Reading a file"
  if (detail) return `${verb} ${detail}`
  return verb === name ? `Used ${name}` : verb
}

const TONE = "text-muted-foreground transition-colors group-hover/tool-row:text-foreground group-focus-visible/tool-row:text-foreground"

type WorkChunk = { kind: "single"; block: Block } | { kind: "tools"; blocks: ToolBlock[] }

function chunkWork(blocks: readonly Block[], tasksByToolCall: ReadonlyMap<string, RuntimeTask>): WorkChunk[] {
  const chunks: WorkChunk[] = []
  let tools: ToolBlock[] = []
  const flush = () => {
    if (tools.length >= 2) chunks.push({ kind: "tools", blocks: tools })
    else if (tools[0]) chunks.push({ kind: "single", block: tools[0] })
    tools = []
  }
  for (const block of blocks) {
    const linkedTask = block.kind === "tool" ? tasksByToolCall.get(block.call.id) : undefined
    if (
      block.kind === "tool" &&
      block.complete &&
      !block.isError &&
      !isAgentLaunchBlock(block, linkedTask) &&
      (!linkedTask || !isRuntimeTaskActive(linkedTask))
    ) {
      tools.push(block)
    } else {
      flush()
      chunks.push({ kind: "single", block })
    }
  }
  flush()
  return chunks
}

function WorkList({ blocks, tasks = EMPTY_RUNTIME_TASKS, tone = "muted", liveTextId = null, onOpenAgentActivity }: { blocks: readonly Block[]; tasks?: readonly RuntimeTask[]; tone?: WorkTone; liveTextId?: string | null; onOpenAgentActivity: OpenAgentActivity }) {
  const tasksByToolCall = new Map(tasks.flatMap((task) => (task.tool_call_id ? [[task.tool_call_id, task] as const] : [])))
  const hierarchy = buildWorkHierarchy(blocks)
  return <WorkRows blocks={hierarchy.roots} tasksByToolCall={tasksByToolCall} childrenByParent={hierarchy.childrenByParent} tone={tone} liveTextId={liveTextId} onOpenAgentActivity={onOpenAgentActivity} />
}

type WorkTone = "bright" | "muted"

function WorkRows({
  blocks,
  tasksByToolCall,
  childrenByParent,
  tone = "muted",
  liveTextId = null,
  compact = false,
  onOpenAgentActivity,
}: {
  blocks: readonly Block[]
  tasksByToolCall: ReadonlyMap<string, RuntimeTask>
  childrenByParent: ReadonlyMap<string, ToolBlock[]>
  tone?: WorkTone
  liveTextId?: string | null
  compact?: boolean
  onOpenAgentActivity: OpenAgentActivity
}) {
  const chunks: WorkChunk[] = compact ? chunkWork(blocks, tasksByToolCall) : blocks.map((block) => ({ kind: "single", block }))
  return chunks.map((chunk) =>
    chunk.kind === "single" ? (
      <WorkRow
        key={chunk.block.id}
        block={chunk.block}
        task={chunk.block.kind === "tool" ? tasksByToolCall.get(chunk.block.call.id) : undefined}
        tasksByToolCall={tasksByToolCall}
        childrenByParent={childrenByParent}
        tone={tone}
        live={chunk.block.kind === "assistant" && chunk.block.id === liveTextId}
        onOpenAgentActivity={onOpenAgentActivity}
      />
    ) : (
      <ToolGroupRow
        key={`${chunk.blocks[0]!.id}:${chunk.blocks.at(-1)!.id}`}
        blocks={chunk.blocks}
        tasksByToolCall={tasksByToolCall}
        childrenByParent={childrenByParent}
        onOpenAgentActivity={onOpenAgentActivity}
      />
    ),
  )
}

function ToolGroupRow({
  blocks,
  tasksByToolCall,
  childrenByParent,
  onOpenAgentActivity,
}: {
  blocks: ToolBlock[]
  tasksByToolCall: ReadonlyMap<string, RuntimeTask>
  childrenByParent: ReadonlyMap<string, ToolBlock[]>
  onOpenAgentActivity: OpenAgentActivity
}) {
  const [open, setOpen] = useState(false)
  const summary = summarizeToolCalls(blocks.map((block) => ({ call: block.call, complete: block.complete, isError: block.isError })))
  if (!summary)
    return blocks.map((block) => (
      <ToolRow
        key={block.id}
        block={block}
        task={tasksByToolCall.get(block.call.id)}
        tasksByToolCall={tasksByToolCall}
        childrenByParent={childrenByParent}
        onOpenAgentActivity={onOpenAgentActivity}
      />
    ))
  return (
    <div className="py-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="group/tool-row flex w-full cursor-pointer items-center gap-1.5 text-start focus-visible:outline-none"
      >
        <span data-work-entry-icon className={cn("flex size-4 shrink-0 items-center justify-center", TONE)}>
          {workIcon(summary.visual, false)}
        </span>
        <span className={cn("min-w-0 flex-1 truncate leading-6", TONE)} style={CHAT_FONT}>
          {summary.label}
        </span>
        <DisclosureChevron open={open} className="text-muted-foreground/65 group-hover/tool-row:text-foreground" />
      </button>
      <DisclosureRegion open={open} contentClassName="ms-5 mt-0.5 space-y-0.5 ps-0.5">
        {blocks.map((block) => (
          <ToolRow
            key={block.id}
            block={block}
            task={tasksByToolCall.get(block.call.id)}
            tasksByToolCall={tasksByToolCall}
            childrenByParent={childrenByParent}
            onOpenAgentActivity={onOpenAgentActivity}
          />
        ))}
      </DisclosureRegion>
    </div>
  )
}

function WorkRow({
  block,
  task,
  tasksByToolCall,
  childrenByParent,
  tone = "muted",
  live = false,
  onOpenAgentActivity,
}: {
  block: Block
  task?: RuntimeTask
  tasksByToolCall: ReadonlyMap<string, RuntimeTask>
  childrenByParent: ReadonlyMap<string, ToolBlock[]>
  tone?: WorkTone
  live?: boolean
  onOpenAgentActivity: OpenAgentActivity
}) {
  switch (block.kind) {
    case "tool":
      return <ToolRow block={block} task={task} tasksByToolCall={tasksByToolCall} childrenByParent={childrenByParent} onOpenAgentActivity={onOpenAgentActivity} />
    case "assistant":
      return <AssistantWorkRow block={block} tone={tone} live={live} />
    case "runtime_task":
      return <RuntimeTaskTranscriptRow task={block.task} onOpenAgentActivity={onOpenAgentActivity} />
    case "approval":
      return (
        <div className="rounded-lg py-1">
          <div className="flex w-full items-center gap-2">
            <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
              {block.decision ? <CheckIcon className="size-4 text-muted-foreground/50" /> : <Spinner size={14} />}
            </span>
            <p className="truncate leading-6 text-muted-foreground" style={CHAT_FONT}>
              {isUserInput(block.approval)
                ? block.decision ? block.decision.decision === "deny" ? "Input request declined" : "Answered the agent’s questions" : "Waiting for your input"
                : <>{block.decision ? (block.decision.decision === "deny" ? "Declined " : "Approved ") : "Waiting to approve "}{block.approval.summary || block.approval.tool_name}</>}
            </p>
          </div>
        </div>
      )
    case "notice":
      return (
        <div className="rounded-lg py-1">
          <div className="flex w-full items-center gap-2">
            <span className={cn("flex size-5 shrink-0 items-center justify-center", block.level === "error" ? "text-destructive" : "text-muted-foreground")}>
              <CircleAlertIcon className="size-4" />
            </span>
            <p className={cn("min-w-0 leading-6", block.level === "error" ? "text-destructive" : "text-muted-foreground")} style={CHAT_FONT}>
              {block.text}
            </p>
          </div>
        </div>
      )
    default:
      return null
  }
}

function ToolRow({
  block,
  task,
  tasksByToolCall,
  childrenByParent,
  onOpenAgentActivity,
  showTimestamp = false,
}: {
  block: Extract<Block, { kind: "tool" }>
  task?: RuntimeTask
  tasksByToolCall: ReadonlyMap<string, RuntimeTask>
  childrenByParent: ReadonlyMap<string, ToolBlock[]>
  onOpenAgentActivity: OpenAgentActivity
  showTimestamp?: boolean
}) {
  const [open, setOpen] = useState(false)
  const active = !!task && isRuntimeTaskActive(task)
  const activity = toolLine(block.call, block.complete && !active)
  const visual = toolVisualKind(block.call, activity)
  const out = outputText(block.output, block.stream)
  const childBlocks = childrenByParent.get(block.call.id) ?? []
  const hasChildActivity = childBlocks.length > 0
  const hasOutput = out.trim().length > 0
  const opensFocusedActivity = isAgentLaunchBlock(block, task)
  const canExpand = !opensFocusedActivity && (hasChildActivity || hasOutput)
  const canOpen = opensFocusedActivity || canExpand
  const tone = block.isError
    ? "text-destructive/80 transition-colors group-hover/tool-row:text-destructive group-focus-visible/tool-row:text-destructive"
    : TONE
  return (
    <div className="rounded-lg py-1">
      <button
        type="button"
        data-agent-launch-row={opensFocusedActivity ? "true" : undefined}
        onClick={() => {
          if (opensFocusedActivity) {
            onOpenAgentActivity({ kind: "tool", turnId: block.turnId, toolCallId: block.call.id })
            return
          }
          if (canExpand) setOpen((value) => !value)
        }}
        aria-expanded={canExpand ? open : undefined}
        className={cn("group/tool-row flex w-full items-center gap-1.5 text-start", canOpen ? "cursor-pointer focus-visible:outline-none" : "cursor-default")}
      >
        <span data-work-entry-icon className={cn("flex size-4 shrink-0 items-center justify-center", tone)}>
          {workIcon(visual, block.isError)}
        </span>
        <div className="min-w-0 flex-1 overflow-hidden">
          <p className={cn("truncate leading-6", tone, (!block.complete || active) && "shimmer")} style={CHAT_FONT}>
            <span data-work-entry-display-text>{workLabel(activity, block.call.name, block.complete && !active, block.isError)}</span>
          </p>
        </div>
        {showTimestamp && <time dateTime={block.at} className="shrink-0 font-system-ui text-[11px] tabular-nums text-muted-foreground/38">{clockTime(block.at)}</time>}
        {opensFocusedActivity
          ? <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/55 transition-colors group-hover/tool-row:text-foreground" />
          : canExpand && <DisclosureChevron open={open} className="text-muted-foreground/70 group-hover/tool-row:text-foreground" />}
      </button>
      {canExpand && (
        <DisclosureRegion open={open} contentClassName="ms-[1.375rem] min-w-0 pt-1.5">
          {hasChildActivity && (
            <section aria-label={activity.kind === "delegate" ? "Subagent activity" : "Nested activity"} className={cn("min-w-0", hasOutput && "pb-2.5")}>
              <p className="pb-0.5 font-system-ui text-[11px] leading-5 text-muted-foreground/45">
                {activity.kind === "delegate" ? "Subagent activity" : "Nested activity"}
              </p>
              <div className="space-y-0.5">
                <WorkRows blocks={childBlocks} tasksByToolCall={tasksByToolCall} childrenByParent={childrenByParent} onOpenAgentActivity={onOpenAgentActivity} />
              </div>
            </section>
          )}
          {hasOutput && (
            <section aria-label={hasChildActivity ? "Result" : undefined}>
              {hasChildActivity && <p className="pb-1 font-system-ui text-[11px] leading-5 text-muted-foreground/45">Result</p>}
              <pre
                className={cn(
                  "selectable max-h-72 overflow-auto rounded-lg bg-[var(--app-chat-code-surface)] px-3 py-2.5 font-chat-code text-[length:var(--app-font-size-chat-code,13px)] leading-relaxed whitespace-pre-wrap break-words outline -outline-offset-1 outline-black/6 dark:outline-white/8",
                  block.isError ? "text-destructive/90" : "text-foreground/92",
                )}
              >
                {out}
              </pre>
            </section>
          )}
        </DisclosureRegion>
      )}
    </div>
  )
}

function AssistantWorkRow({ block, tone = "muted", live = false }: { block: Extract<Block, { kind: "assistant" }>; tone?: WorkTone; live?: boolean }) {
  const [open, setOpen] = useState(false)
  // Smooth the reasoning stream too, but only while it is both live and expanded.
  const thinking = useSmoothStream(block.thinking, !block.complete && open)
  // Smooth only the segment currently receiving deltas. Its keyed row remains
  // in place when tools or delegated tasks arrive after it.
  const revealed = useSmoothStream(block.text, live && !block.complete, block.complete)
  const bodyText = useDeferredValue(revealed)
  const hasThinking = block.thinking.trim().length > 0
  const hasText = block.text.trim().length > 0
  const showText = hasText && (!live || block.complete || shouldRevealLiveText(block.text, block.complete))
  if (!hasThinking && !showText) return null
  return (
    <>
      {hasThinking && (
        <div className="rounded-lg py-1">
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="group/tool-row flex w-full cursor-pointer items-center gap-2 text-left focus-visible:outline-none">
            <span className={cn("flex size-5 shrink-0 items-center justify-center", TONE)}>
              {block.complete ? <BrainIcon className="size-4" /> : <Spinner size={14} className="text-muted-foreground" />}
            </span>
            <div className="min-w-0 overflow-hidden">
              <p className={cn("truncate leading-6", TONE, !block.complete && "shimmer")} style={CHAT_FONT}>
                {block.complete ? "Thought" : "Thinking"}
              </p>
            </div>
            <DisclosureChevron open={open} className="text-muted-foreground/70 group-hover/tool-row:text-foreground" />
          </button>
          <DisclosureRegion open={open} contentClassName="min-w-0 pt-2 ms-7">
            <p className="selectable whitespace-pre-wrap text-muted-foreground" style={TEXT}>
              {thinking}
            </p>
          </DisclosureRegion>
        </div>
      )}
      {showText && (
        <div className="chat-message-segment flex flex-col gap-1.5 pr-[2px] pl-[2px]">
          {tone === "bright" ? (
            <Markdown text={bodyText} style={TEXT} />
          ) : (
            <div className="text-muted-foreground">
              <Markdown text={bodyText} className="[&_*]:text-muted-foreground" style={TEXT} />
            </div>
          )}
        </div>
      )}
    </>
  )
}

const MAX_VISIBLE_CHANGED_FILES = 5

function EditedFilesCard({ diff, threadId, turnId, canUndo }: { diff: Diff; threadId: ThreadId; turnId: string; canUndo: boolean }) {
  const [expanded, setExpanded] = useState(true)
  const [showAllFor, setShowAllFor] = useState<string | null>(null)
  const [reverting, setReverting] = useState(false)
  const [openFiles, setOpenFiles] = useState<Record<string, boolean>>({})
  const set = useStore((s) => s.set)
  const toggleFile = (path: string) => setOpenFiles((o) => ({ ...o, [path]: !o[path] }))
  const fileFor = (f: Diff["files"][number]): FileDiff =>
    ({ path: f.path, oldPath: f.old_path ?? null, status: f.status === "added" ? "added" : f.status === "deleted" ? "deleted" : "modified", binary: f.binary, hunks: [], additions: f.additions, deletions: f.deletions })
  const adds = diff.files.reduce((n, f) => n + f.additions, 0)
  const dels = diff.files.reduce((n, f) => n + f.deletions, 0)
  const head = diff.files.slice(0, MAX_VISIBLE_CHANGED_FILES)
  const rest = diff.files.slice(MAX_VISIBLE_CHANGED_FILES)
  const restKey = rest.map((file) => file.path).join("\u0000")
  const showAll = rest.length > 0 && showAllFor === restKey
  const review = () => set({ rightOpen: true, rightTab: "changes" })

  const undo = async () => {
    setReverting(true)
    try {
      await revertTo(threadId, turnId)
      toast("Workspace reverted")
    } catch (e) {
      toast.error("Unable to revert", { description: errorText(e) })
    } finally {
      setReverting(false)
    }
  }

  return (
    <div className="mt-2 mb-1 overflow-hidden rounded-[0.65rem] border border-[color:var(--color-border-light)] dark:border-[color:color-mix(in_srgb,var(--color-border-light)_55%,transparent)]">
      <div
        className={cn(
          "flex items-center justify-between gap-3 bg-[color:color-mix(in_srgb,var(--app-chat-code-surface)_40%,transparent)] px-3 py-1.5",
          expanded && "border-b border-[color:var(--color-border-light)]",
        )}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <ChangesIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
          <div className="min-w-0">
            <div className="truncate font-normal text-foreground/92" style={CHAT_FONT}>
              Edited {plural(diff.files.length, "file")}
            </div>
            {(adds > 0 || dels > 0) && (
              <div className="font-system-ui tabular-nums" style={CHAT_FONT}>
                <DiffStatLabel additions={adds} deletions={dels} />
              </div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canUndo && (
            <button type="button" onClick={undo} disabled={reverting} className="flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground" style={CHAT_FONT}>
              Undo {reverting ? <Spinner size={12} /> : <Undo2Icon className="size-3" />}
            </button>
          )}
          <ReviewChangesButton onClick={review} style={CHAT_FONT} />
          <button
            type="button"
            aria-label={expanded ? "Collapse changed files list" : "Expand changed files list"}
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex items-center justify-center rounded-md p-1 text-muted-foreground/70 transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground/80"
          >
            <DisclosureChevron open={expanded} className="dark:text-muted-foreground/50" />
          </button>
        </div>
      </div>
      <DisclosureRegion open={expanded}>
        {head.map((f, i) => (
          <EditedFileRow key={f.path} file={fileFor(f)} threadId={threadId} turnId={turnId} first={i === 0} open={!!openFiles[f.path]} onToggle={() => toggleFile(f.path)} onReview={review} />
        ))}
        <DisclosureRegion open={showAll}>
          {rest.map((f) => (
            <EditedFileRow key={f.path} file={fileFor(f)} threadId={threadId} turnId={turnId} open={!!openFiles[f.path]} onToggle={() => toggleFile(f.path)} onReview={review} />
          ))}
        </DisclosureRegion>
        {rest.length > 0 && (
          <button
            type="button"
            onClick={() => setShowAllFor(showAll ? null : restKey)}
            className="flex w-full items-center justify-start gap-1.5 border-t border-[color:var(--color-border-light)] bg-transparent px-3 py-2 font-system-ui font-normal text-muted-foreground transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground"
            style={CHAT_FONT}
          >
            <DisclosureChevron open={showAll} />
            {showAll ? "Show less" : `Show ${plural(rest.length, "more file")}`}
          </button>
        )}
      </DisclosureRegion>
    </div>
  )
}

/** A changed file: click the row to unfold its diff in place; the trailing button opens the dock. */
function EditedFileRow({ file, threadId, turnId, first, open, onToggle, onReview }: { file: FileDiff; threadId: ThreadId; turnId: string; first?: boolean; open: boolean; onToggle: () => void; onReview: () => void }) {
  const [loadedFile, setLoadedFile] = useState<FileDiff | null>(file.binary ? file : null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [truncated, setTruncated] = useState(false)

  const toggle = () => {
    onToggle()
    if (open || loadedFile || loading || file.binary) return
    setLoading(true)
    setFailed(false)
    void loadFileDiff(threadId, file.path, turnId)
      .then((result) => {
        setLoadedFile(parseUnifiedDiff(result.patch).find((candidate) => candidate.path === file.path) ?? file)
        setTruncated(!!result.patch_truncated)
      })
      .catch(() => setFailed(true))
      .finally(() => setLoading(false))
  }

  return (
    <div className={cn("border-t border-[color:var(--color-border-light)]", first && "border-t-0")}>
      <div
        data-edited-file-row
        className="flex w-full min-w-0 items-center gap-1.5 overflow-hidden bg-transparent py-1.5 pr-2 transition-colors hover:bg-[var(--color-background-button-secondary-hover)] dark:bg-transparent dark:hover:bg-transparent"
      >
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} changes to ${file.path}`}
          onClick={toggle}
          className="group/file-row flex min-w-0 flex-1 items-center gap-2 self-stretch bg-transparent py-1 pl-3 text-left focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
        >
          <DisclosureChevron open={open} className="text-muted-foreground/60" />
          <FileEntryIcon pathValue={file.path} kind="file" colorMode="inherit" className="size-4 text-[var(--color-text-foreground)] opacity-70 dark:opacity-80" />
          <span className="min-w-0 truncate font-system-ui font-normal text-[var(--color-text-foreground)] underline-offset-2 group-hover/file-row:underline group-focus-visible/file-row:underline" style={CHAT_FONT}>
            {file.path}
          </span>
          <span className="ml-auto shrink-0 font-system-ui tabular-nums" style={CHAT_FONT}>
            <DiffStatLabel additions={file.additions} deletions={file.deletions} />
          </span>
        </button>
        <button
          type="button"
          aria-label={`Open ${file.path} in the diff panel`}
          title="Open in the diff panel"
          onClick={onReview}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground"
        >
          <PanelRightCloseIcon className="size-3.5" />
        </button>
      </div>
      <DisclosureRegion open={open}>
        <div className="border-t border-[color:var(--color-border-light)] bg-[var(--background)]">
          {loading ? (
            <p className="shimmer px-3 py-2 font-system-ui text-[11px] text-muted-foreground/75">Loading changes…</p>
          ) : failed ? (
            <p className="px-3 py-2 font-system-ui text-[11px] text-destructive">Unable to load this file’s changes.</p>
          ) : loadedFile ? (
            <FileDiffBody file={loadedFile} truncated={truncated} />
          ) : null}
        </div>
      </DisclosureRegion>
    </div>
  )
}
