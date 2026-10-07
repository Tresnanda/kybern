// Subagent launches in a parent transcript: one row for a single launch, and the
// "N subagents" group for two or more. Both replace the old "Delegating X" rows for agent
// tasks and open the subagent page. A launch whose child thread is not known (history from
// before child threads existed) keeps its old row and the activity overlay.

import { memo, useContext, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react"

import {
  findSubagentFor,
  subagentCounts,
  subagentCountsDescription,
  subagentDetail,
  subagentGroupDefaultOpen,
  subagentGroupSpan,
  subagentGroupTitle,
  subagentPhase,
  subagentRowLabel,
  subagentStatusSegments,
  subagentThreadPhase,
  subagentTypeLabel,
  type SubagentPhase,
} from "../../../../../packages/kybern-client/src/subagents.ts"
import type { Block } from "../../../../../packages/kybern-client/src/transcript.ts"
import { ProviderMark } from "@/components/kybern/bits"
import { ElapsedText } from "@/components/kybern/ElapsedText"
import { TextSwap } from "@/components/kybern/motion"
import { DisclosureChevron } from "@/components/kit/DisclosureChevron"
import { DisclosureRegion } from "@/components/kit/DisclosureRegion"
import { getChatTranscriptTextStyle } from "@/components/kit/chat/chatTypography"
import { ImageThreadContext } from "@/lib/imageThread"
import { ChevronRightIcon } from "@/lib/kit/icons"
import { toolLine } from "@/lib/toolActivity"
import { useTranscriptRowState } from "@/lib/transcriptRowState"
import { cn } from "@/lib/utils"
import type { ProviderInstance, RuntimeTask, Thread } from "@/protocol"
import { openThreadView, useSubagentChildren, useSubagentModel } from "@/state/subagents"
import { useStore } from "@/state/store"
import { SubagentHoverCard } from "./SubagentHoverCard"
import { ProviderAvatarStack, SubagentGlyph } from "./parts"

const TEXT = getChatTranscriptTextStyle()
const CHAT_FONT = { fontSize: TEXT.fontSize }

export type LaunchBlock = Extract<Block, { kind: "tool" | "runtime_task" }>
export type OpenLegacyActivity = (target: { kind: "tool"; turnId: string; toolCallId: string } | { kind: "task"; turnId: string; taskId: string }) => void

function launchOf(block: LaunchBlock, tasksByToolCall: ReadonlyMap<string, RuntimeTask>) {
  return block.kind === "tool"
    ? { toolCallId: block.call.id, taskId: tasksByToolCall.get(block.call.id)?.id }
    : { toolCallId: block.task.tool_call_id, taskId: block.task.id }
}

function taskOf(block: LaunchBlock, tasksByToolCall: ReadonlyMap<string, RuntimeTask>): RuntimeTask | undefined {
  return block.kind === "runtime_task" ? block.task : tasksByToolCall.get(block.call.id)
}

/** What a launch looks like to the rows: from its child thread when there is one, else from its runtime task or call. */
interface Member {
  key: string
  block: LaunchBlock
  thread?: Thread
  task?: RuntimeTask
  title: string
  phase: SubagentPhase
  /** Shaped like a thread's `subagent` record, for group timing. */
  timed: { subagent: NonNullable<Thread["subagent"]> | null }
}

function buildMember(block: LaunchBlock, tasksByToolCall: ReadonlyMap<string, RuntimeTask>, children: readonly Thread[]): Member {
  const task = taskOf(block, tasksByToolCall)
  const thread = findSubagentFor(children, launchOf(block, tasksByToolCall))
  const call = block.kind === "tool" ? block.call : undefined
  const title = thread?.title || task?.title || (call ? toolLine(call, block.kind === "tool" && block.complete).detail : "") || "Subagent"
  const phase: SubagentPhase = thread
    ? subagentThreadPhase(thread)
    : task
      ? subagentPhase(task.status)
      : block.kind === "tool" && block.complete
        ? block.isError ? "failed" : "done"
        : "working"
  const timed = thread
    ? { subagent: thread.subagent ?? null }
    : {
        subagent: {
          task_id: task?.id ?? block.id,
          root_thread_id: "",
          parent_turn_id: block.turnId,
          status: task?.status ?? (phase === "working" ? "running" : phase === "failed" ? "failed" : "completed"),
          started_at: task?.started_at ?? block.at,
          completed_at: task?.completed_at ?? null,
          stats: task?.stats,
        } as NonNullable<Thread["subagent"]>,
      }
  return { key: block.id, block, thread, task, title, phase, timed }
}

function useMembers(blocks: readonly LaunchBlock[], tasksByToolCall: ReadonlyMap<string, RuntimeTask>) {
  const parentId = useContext(ImageThreadContext)
  const children = useSubagentChildren(parentId ?? "")
  return useMemo(() => blocks.map((block) => buildMember(block, tasksByToolCall, children)), [blocks, tasksByToolCall, children])
}

/** A stand-in thread for fallback rows, so model and avatar helpers work without a child thread. */
function pseudoThread(member: Member, parent: ProviderInstance | undefined): Pick<Thread, "model" | "effort" | "provider"> {
  return {
    model: member.thread?.model ?? member.task?.model ?? null,
    effort: member.thread?.effort ?? member.task?.effort ?? null,
    provider: member.thread?.provider ?? parent ?? { kind: "claude-code" } as ProviderInstance,
  }
}

function useParentProvider(): ProviderInstance | undefined {
  const parentId = useContext(ImageThreadContext)
  return useStore((state) => (parentId ? state.threads[parentId]?.provider : undefined))
}

function memberTypeLabel(member: Member): string | null {
  return subagentTypeLabel(member.thread?.subagent?.agent_type ?? member.task?.provider_type)
}

function memberDetail(member: Member): { text: string; failed: boolean } | null {
  if (member.thread) return subagentDetail(member.thread)
  const line = member.task?.detail?.split("\n").map((part) => part.trim()).find(Boolean)
  if (line) return { text: line, failed: member.phase === "failed" }
  return member.task?.last_tool_name && member.phase === "working" ? { text: `Using ${member.task.last_tool_name}`, failed: false } : null
}

function memberSpan(member: Member): { startedAt: number; endedAt: number | null } | null {
  const info = member.timed.subagent
  const startedAt = info ? Date.parse(info.started_at) : NaN
  if (!Number.isFinite(startedAt)) return null
  if (member.phase === "working") return { startedAt, endedAt: null }
  const endedAt = info?.completed_at ? Date.parse(info.completed_at) : NaN
  return { startedAt, endedAt: Number.isFinite(endedAt) ? endedAt : null }
}

// ---- one member of a group, and a lone launch ----

function MemberButton({
  member,
  parent,
  onOpen,
  variant,
  tabIndex,
  onKeyDown,
}: {
  member: Member
  parent: ProviderInstance | undefined
  onOpen: (member: Member) => void
  variant: "member" | "single"
  tabIndex?: number
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void
}) {
  const pseudo = pseudoThread(member, parent)
  const { model } = useSubagentModel(pseudo)
  const type = memberTypeLabel(member)
  const detail = memberDetail(member)
  const span = memberSpan(member)
  const [now] = useState(() => Date.now())
  const label = member.thread ? subagentRowLabel(member.thread, now) : `Open ${member.title}, ${member.phase === "working" ? "working" : member.phase}`
  const meta = [type, model].filter(Boolean).join(" · ")
  const button = (
    <button
      type="button"
      data-sa-member=""
      data-agent-launch-row="true"
      aria-label={label}
      tabIndex={tabIndex}
      onKeyDown={onKeyDown}
      onClick={() => onOpen(member)}
      className={cn(
        "group/sa-m flex min-w-0 cursor-pointer items-center text-start outline-hidden focus-visible:ring-2 focus-visible:ring-ring/60",
        variant === "member"
          ? "-ms-2 h-8 w-[calc(100%+0.5rem)] gap-2 rounded-lg px-2 hover:bg-[var(--color-background-button-secondary-hover)]"
          : "w-full gap-2.5 rounded-lg py-1 pe-1.5",
      )}
    >
      {variant === "single" && (
        <span className="sa-avatar sa-avatar--single shrink-0" aria-hidden>
          <ProviderMark kind={pseudo.provider.kind} size={12} className="size-3" />
        </span>
      )}
      {variant === "member" && (member.thread ? <SubagentGlyph thread={member.thread} /> : <FallbackGlyph phase={member.phase} />)}
      <span title={member.title} className={cn("min-w-0 max-w-[55%] truncate text-foreground/90", variant === "single" && "text-foreground/88")} style={variant === "member" ? { fontSize: 13 } : CHAT_FONT}>
        {member.title}
      </span>
      <span
        className={cn("sa-secondary min-w-0 flex-1 truncate text-xs", detail?.failed ? "text-destructive/85" : "text-foreground/45")}
        title={detail?.text}
      >
        {variant === "member" ? [detail?.failed ? null : type, detail?.text].filter(Boolean).join(" · ") || type : meta}
      </span>
      {span && <ElapsedText startedAt={span.startedAt} endedAt={span.endedAt} className="shrink-0 whitespace-nowrap text-xs text-foreground/48" />}
      {variant === "single" && (member.thread ? <SubagentGlyph thread={member.thread} /> : <FallbackGlyph phase={member.phase} />)}
      <ChevronRightIcon className="size-3.5 shrink-0 text-foreground/40 transition-colors group-hover/sa-m:text-foreground" />
    </button>
  )
  if (!member.thread) return button
  return <SubagentHoverCard thread={member.thread} trigger={button} side="bottom" align="start" />
}

function FallbackGlyph({ phase }: { phase: SubagentPhase }) {
  return <SubagentGlyph thread={{ subagent: { status: phase === "working" ? "running" : phase === "done" ? "completed" : phase === "failed" ? "failed" : "stopped" } as NonNullable<Thread["subagent"]> }} />
}

function useOpenMember(onOpenLegacy: OpenLegacyActivity) {
  return (member: Member) => {
    if (member.thread) {
      openThreadView(member.thread.id)
      return
    }
    const block = member.block
    if (block.kind === "tool") onOpenLegacy({ kind: "tool", turnId: block.turnId, toolCallId: block.call.id })
    else onOpenLegacy({ kind: "task", turnId: block.task.origin_turn_id, taskId: block.task.id })
  }
}

/**
 * A lone subagent launch. `legacy` is the row the transcript used before child threads
 * existed; it shows when this launch has no child thread.
 */
export const SubagentLaunchRow = memo(function SubagentLaunchRow({
  block,
  tasksByToolCall,
  onOpenLegacy,
  legacy,
}: {
  block: LaunchBlock
  tasksByToolCall: ReadonlyMap<string, RuntimeTask>
  onOpenLegacy: OpenLegacyActivity
  legacy: ReactNode
}) {
  const blocks = useMemo(() => [block], [block])
  const [member] = useMembers(blocks, tasksByToolCall)
  const parent = useParentProvider()
  const open = useOpenMember(onOpenLegacy)
  if (!member?.thread) return legacy
  return (
    <div className="py-0.5">
      <MemberButton member={member} parent={parent} onOpen={open} variant="single" />
    </div>
  )
})

// ---- the group ----

export const SubagentGroupRow = memo(function SubagentGroupRow({
  blocks,
  tasksByToolCall,
  onOpenLegacy,
}: {
  blocks: readonly Block[]
  tasksByToolCall: ReadonlyMap<string, RuntimeTask>
  onOpenLegacy: OpenLegacyActivity
}) {
  const launches = blocks as readonly LaunchBlock[]
  const members = useMembers(launches, tasksByToolCall)
  const parent = useParentProvider()
  const open = useOpenMember(onOpenLegacy)
  const counts = useMemo(() => subagentCounts(members.map((member) => member.phase)), [members])
  const segments = subagentStatusSegments(counts)
  const span = useMemo(() => subagentGroupSpan(members.map((member) => member.timed)), [members])
  // The reader's own choice wins; until then the default follows the state of the group.
  const [chosen, setChosen] = useTranscriptRowState<boolean | null>("subagents", null)
  const expanded = chosen ?? subagentGroupDefaultOpen(counts)
  const kinds = members.map((member) => member.thread?.provider.kind ?? parent?.kind ?? "claude-code")
  const title = subagentGroupTitle(members.length)
  const list = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(0)

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return
    const buttons = list.current?.querySelectorAll<HTMLButtonElement>("button[data-sa-member]")
    if (!buttons?.length) return
    event.preventDefault()
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : Math.min(buttons.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))
    setActive(next)
    buttons[next]?.focus()
  }

  return (
    <div className="my-1" data-subagent-group="">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={title}
        // `aria-description` is not in every typing of React yet.
        {...{ "aria-description": subagentCountsDescription(counts) }}
        onClick={() => setChosen(!expanded)}
        className="group/sa flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] py-1.5 pe-1.5 text-start outline-hidden focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <ProviderAvatarStack kinds={kinds} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="leading-5 text-foreground/88 transition-colors group-hover/sa:text-foreground" style={CHAT_FONT}>{title}</span>
          <span className="sa-secondary flex min-w-0 items-center gap-1 whitespace-nowrap text-xs leading-4 text-muted-foreground">
            {segments.map((segment, index) => (
              <span key={segment.phase} className="inline-flex min-w-0 items-center gap-1">
                {index > 0 && <span aria-hidden>·</span>}
                <TextSwap text={segment.text} shimmer={segment.phase === "working"} className={cn(segment.phase === "failed" && "text-destructive")} />
              </span>
            ))}
          </span>
        </span>
        {span && <ElapsedText startedAt={span.startedAt} endedAt={span.endedAt} className="shrink-0 whitespace-nowrap text-xs text-foreground/48" />}
        <DisclosureChevron open={expanded} className="size-3 text-foreground/55" />
      </button>
      <DisclosureRegion open={expanded}>
        <div ref={list} role="list" className="ms-[34px] flex flex-col gap-px pb-1">
          {members.map((member, index) => (
            <div key={member.key} role="listitem">
              <MemberButton
                member={member}
                parent={parent}
                onOpen={open}
                variant="member"
                tabIndex={index === Math.min(active, members.length - 1) ? 0 : -1}
                onKeyDown={(event) => onKeyDown(event, index)}
              />
            </div>
          ))}
        </div>
      </DisclosureRegion>
    </div>
  )
})
