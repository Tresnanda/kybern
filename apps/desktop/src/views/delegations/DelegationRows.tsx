// `kybern_agent_delegate` calls in a parent transcript: one row for a single delegation and an
// "N delegated agents" group for two or more. Both read the live state of the child thread, open
// it on click, and fall back to the call itself until the child is known (history, or a call that
// is still starting). Same bones as the subagent rows, so the two read as one family.

import { memo, useContext, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { useShallow } from "zustand/react/shallow"

import {
  childEndedAt,
  childStartedAt,
  conflictsLabel,
  delegationRoleLabel,
  delegationState,
  launchCounts,
  launchGroupDefaultOpen,
  launchGroupTitle,
  launchState,
  workspaceLabel,
  type ChildPhase,
} from "../../../../../packages/kybern-client/src/delegations.ts"
import { delegateTitle, parseDelegateInput, parseDelegateResult } from "../../../../../packages/kybern-client/src/orchestrationTools.ts"
import type { Block } from "../../../../../packages/kybern-client/src/transcript.ts"
import { ProviderMark } from "@/components/kybern/bits"
import { ElapsedText } from "@/components/kybern/ElapsedText"
import { TextSwap } from "@/components/kybern/motion"
import { DisclosureChevron } from "@/components/kit/DisclosureChevron"
import { DisclosureRegion } from "@/components/kit/DisclosureRegion"
import { getChatTranscriptTextStyle } from "@/components/kit/chat/chatTypography"
import { ImageThreadContext } from "@/lib/imageThread"
import { ChevronRightIcon, TriangleAlertIcon } from "@/lib/kit/icons"
import { useTranscriptRowState } from "@/lib/transcriptRowState"
import { cn } from "@/lib/utils"
import type { ProviderKind, Thread } from "@/protocol"
import { openThreadView, useSubagentModel } from "@/state/subagents"
import { useStore } from "@/state/store"
import { ProviderAvatarStack } from "../subagents/parts"
import { ChildGlyph } from "../lineage/parts"
import { phaseWordClass } from "../lineage/phaseStyles"

const TEXT = getChatTranscriptTextStyle()
const CHAT_FONT = { fontSize: TEXT.fontSize }

type ToolBlock = Extract<Block, { kind: "tool" }>

const PROVIDER_KINDS: readonly string[] = ["claude-code", "codex", "cursor", "opencode", "pi", "omp"]

/** What a launch row shows: from the child thread when it is known, from the call and its result before. */
interface Launch {
  key: string
  block: ToolBlock
  threadId: string | null
  thread: Thread | undefined
  title: string
  state: { phase: ChildPhase; word: string }
  role: string | null
  workspace: string | null
  provider: ProviderKind | null
  modelText: string | null
}

function launchIds(block: ToolBlock) {
  const result = parseDelegateResult(block.output)
  const input = parseDelegateInput(block.call.input)
  return { result, input, threadId: result?.threadId ?? null, operationId: input.operationId }
}

function useLaunches(blocks: readonly ToolBlock[]): Launch[] {
  const ids = useMemo(() => blocks.map(launchIds), [blocks])
  // One subscription for the whole set; unrelated thread updates leave the array unchanged.
  const threads = useStore(
    useShallow((state) =>
      ids.map(({ threadId, operationId }) => {
        if (threadId) return state.threads[threadId]
        if (!operationId) return undefined
        for (const thread of Object.values(state.threads)) if (thread.delegation?.operation_id === operationId) return thread
        return undefined
      }),
    ),
  )
  return useMemo(
    () =>
      blocks.map((block, index) => {
        const { result, input, threadId } = ids[index]!
        const thread = threads[index]
        const info = thread?.delegation
        const provider = thread?.provider.kind ?? (result?.provider && PROVIDER_KINDS.includes(result.provider) ? (result.provider as ProviderKind) : input.provider && PROVIDER_KINDS.includes(input.provider) ? (input.provider as ProviderKind) : null)
        const role = info ? delegationRoleLabel(info.role) : input.role ? delegationRoleLabel(input.role) : null
        const workspace = info ? workspaceLabel(info) : (result?.workspace ?? input.workspace) === "worktree" ? "Own worktree" : "Shared checkout"
        // Before the child thread is known, the call's own result says how it stands.
        const state = !thread && result?.status ? delegationState(result.status) : launchState(thread, { complete: block.complete, isError: block.isError })
        return {
          key: block.id,
          block,
          threadId: thread?.id ?? threadId,
          thread,
          title: thread?.title || delegateTitle(block.call.input, result),
          state,
          role,
          workspace,
          provider,
          modelText: thread?.model ?? result?.model ?? input.model ?? null,
        }
      }),
    [blocks, ids, threads],
  )
}

function LaunchGlyph({ phase }: { phase: ChildPhase }) {
  return <ChildGlyph phase={phase} />
}

function conflictCount(launch: Launch): number {
  return launch.thread?.delegation?.conflicts?.length ?? 0
}

function clock(launch: Launch): { startedAt: number; endedAt: number | null } | null {
  if (launch.thread) {
    const startedAt = childStartedAt(launch.thread)
    return startedAt ? { startedAt, endedAt: childEndedAt(launch.thread) } : null
  }
  // Without the child there is no end time, so only a working delegation shows a clock.
  const startedAt = Date.parse(launch.block.at)
  return Number.isFinite(startedAt) && launch.state.phase === "working" ? { startedAt, endedAt: null } : null
}

function useParentProvider(): ProviderKind {
  const parentId = useContext(ImageThreadContext)
  return useStore((state) => (parentId ? state.threads[parentId]?.provider.kind : undefined) ?? "claude-code")
}

function useLaunchModel(launch: Launch, fallback: ProviderKind) {
  const providers = useStore((state) => state.providers)
  const pseudo = useMemo(
    () => ({ model: launch.modelText, effort: launch.thread?.effort ?? null, provider: launch.thread?.provider ?? ({ kind: launch.provider ?? fallback } as Thread["provider"]) }),
    [launch.modelText, launch.thread, launch.provider, fallback],
  )
  // The hook reads the catalog itself; `providers` only keeps this component subscribed to it.
  void providers
  return useSubagentModel(pseudo).model
}

function open(launch: Launch) {
  if (launch.threadId) openThreadView(launch.threadId)
}

/** Meta line under a title: `Implementation · GPT-5.6 Sol · Own worktree`. */
function metaOf(launch: Launch, model: string | null): string {
  return [launch.role, model, launch.workspace].filter(Boolean).join(" · ")
}

// ---- a lone delegation ----

export const DelegationLaunchRow = memo(function DelegationLaunchRow({ block, legacy }: { block: ToolBlock; legacy: ReactNode }) {
  const blocks = useMemo(() => [block], [block])
  const [launch] = useLaunches(blocks)
  const parentKind = useParentProvider()
  const model = useLaunchModel(launch!, parentKind)
  if (!launch) return legacy
  const conflicts = conflictCount(launch)
  const span = clock(launch)
  const label = `${launch.threadId ? "Open " : ""}${launch.title}, ${launch.state.word}`
  return (
    <div className="py-0.5" data-delegation-launch="">
      <button
        type="button"
        data-agent-launch-row="true"
        aria-label={label}
        disabled={!launch.threadId}
        onClick={() => open(launch)}
        className={cn(
          "group/dl flex w-full min-w-0 items-center gap-2.5 rounded-lg py-1 pe-1.5 text-start outline-hidden focus-visible:ring-2 focus-visible:ring-ring/60",
          launch.threadId ? "cursor-pointer" : "cursor-default",
        )}
      >
        <span className="sa-avatar sa-avatar--single shrink-0" aria-hidden>
          <ProviderMark kind={launch.provider ?? parentKind} size={12} className="size-3" />
        </span>
        <span className="max-w-[55%] shrink-0 truncate text-foreground/88" style={CHAT_FONT}>{launch.title}</span>
        <span className="sa-secondary min-w-0 flex-1 truncate text-xs text-foreground/45" title={metaOf(launch, model)}>{metaOf(launch, model)}</span>
        {conflicts > 0 && (
          <span className="inline-flex shrink-0 items-center gap-1 text-xs text-foreground/70">
            <TriangleAlertIcon className="size-3 text-warning" aria-hidden /> {conflictsLabel(conflicts)}
          </span>
        )}
        {span && <ElapsedText startedAt={span.startedAt} endedAt={span.endedAt} className="shrink-0 text-xs text-foreground/48" />}
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs">
          <LaunchGlyph phase={launch.state.phase} />
          <TextSwap text={launch.state.word} shimmer={launch.state.phase === "working"} className={phaseWordClass(launch.state.phase)} />
        </span>
        {launch.threadId && <ChevronRightIcon className="size-3.5 shrink-0 text-foreground/40 transition-colors group-hover/dl:text-foreground" />}
      </button>
    </div>
  )
})

// ---- the group ----

function MemberRow({
  launch,
  parentKind,
  tabIndex,
  onKeyDown,
}: {
  launch: Launch
  parentKind: ProviderKind
  tabIndex: number
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
}) {
  const model = useLaunchModel(launch, parentKind)
  const span = clock(launch)
  const conflicts = conflictCount(launch)
  const meta = metaOf(launch, model)
  return (
    <button
      type="button"
      data-dl-member=""
      data-agent-launch-row="true"
      aria-label={`${launch.threadId ? "Open " : ""}${launch.title}, ${launch.state.word}`}
      disabled={!launch.threadId}
      tabIndex={tabIndex}
      onKeyDown={onKeyDown}
      onClick={() => open(launch)}
      className={cn(
        "group/dl-m -ms-2 flex h-8 w-[calc(100%+0.5rem)] min-w-0 items-center gap-2 rounded-lg px-2 text-start outline-hidden hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:ring-2 focus-visible:ring-ring/60",
        launch.threadId ? "cursor-pointer" : "cursor-default",
      )}
    >
      <LaunchGlyph phase={launch.state.phase} />
      <span className="shrink-0 text-foreground/90" style={{ fontSize: 13 }}>{launch.title}</span>
      <span className="sa-secondary min-w-0 flex-1 truncate text-xs text-foreground/45" title={meta}>{meta}</span>
      {conflicts > 0 && (
        <span className="inline-flex shrink-0 items-center gap-1 text-xs text-foreground/70">
          <TriangleAlertIcon className="size-3 text-warning" aria-hidden /> {conflictsLabel(conflicts)}
        </span>
      )}
      <span className={cn("shrink-0 text-xs", phaseWordClass(launch.state.phase))}>{launch.state.word}</span>
      {span && <ElapsedText startedAt={span.startedAt} endedAt={span.endedAt} className="shrink-0 text-xs text-foreground/48" />}
      <ChevronRightIcon className="size-3.5 shrink-0 text-foreground/40 transition-colors group-hover/dl-m:text-foreground" />
    </button>
  )
}

export const DelegationGroupRow = memo(function DelegationGroupRow({ blocks }: { blocks: readonly Block[] }) {
  const tools = blocks as readonly ToolBlock[]
  const launches = useLaunches(tools)
  const parentKind = useParentProvider()
  const counts = useMemo(() => launchCounts(launches.map((launch) => launch.state.phase)), [launches])
  const segments = useMemo(() => {
    const parts: { phase: ChildPhase; text: string }[] = []
    if (counts.working > 0) parts.push({ phase: "working", text: `${counts.working} working` })
    if (counts.done > 0) parts.push({ phase: "done", text: `${counts.done} done` })
    if (counts.failed > 0) parts.push({ phase: "failed", text: `${counts.failed} failed` })
    if (counts.stopped > 0) parts.push({ phase: "stopped", text: `${counts.stopped} stopped` })
    return parts
  }, [counts])
  const span = useMemo(() => {
    let startedAt = Infinity
    let endedAt = -Infinity
    let running = false
    for (const launch of launches) {
      const own = clock(launch)
      if (!own) return null
      startedAt = Math.min(startedAt, own.startedAt)
      if (launch.state.phase === "working" || launch.state.phase === "waiting") running = true
      else if (own.endedAt !== null) endedAt = Math.max(endedAt, own.endedAt)
      else return null
    }
    return Number.isFinite(startedAt) ? { startedAt, endedAt: running ? null : endedAt } : null
  }, [launches])
  const [chosen, setChosen] = useTranscriptRowState<boolean | null>("delegations", null)
  const expanded = chosen ?? launchGroupDefaultOpen(counts)
  const kinds = launches.map((launch) => launch.provider ?? parentKind)
  const title = launchGroupTitle(launches.length)
  const list = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(0)
  const description = segments.map((segment) => segment.text).join(", ")

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return
    const buttons = list.current?.querySelectorAll<HTMLButtonElement>("button[data-dl-member]:not(:disabled)")
    if (!buttons?.length) return
    event.preventDefault()
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : Math.min(buttons.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))
    setActive(next)
    buttons[next]?.focus()
  }

  return (
    <div className="my-1" data-delegation-group="">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={title}
        // `aria-description` is not in every typing of React yet.
        {...{ "aria-description": description }}
        onClick={() => setChosen(!expanded)}
        className="group/dg flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] py-1.5 pe-1.5 text-start outline-hidden focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <ProviderAvatarStack kinds={kinds} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="leading-5 text-foreground/88 transition-colors group-hover/dg:text-foreground" style={CHAT_FONT}>{title}</span>
          <span className="sa-secondary flex min-w-0 items-center gap-1 whitespace-nowrap text-xs leading-4 text-muted-foreground">
            {segments.map((segment, index) => (
              <span key={segment.phase} className="inline-flex min-w-0 items-center gap-1">
                {index > 0 && <span aria-hidden>·</span>}
                <TextSwap text={segment.text} shimmer={segment.phase === "working"} className={cn(segment.phase === "failed" && "text-destructive")} />
              </span>
            ))}
          </span>
        </span>
        {span && <ElapsedText startedAt={span.startedAt} endedAt={span.endedAt} className="shrink-0 text-xs text-foreground/48" />}
        <DisclosureChevron open={expanded} className="size-3 text-foreground/55" />
      </button>
      <DisclosureRegion open={expanded}>
        <div ref={list} role="list" className="ms-[34px] flex flex-col gap-px pb-1">
          {launches.map((launch, index) => (
            <div key={launch.key} role="listitem">
              <MemberRow
                launch={launch}
                parentKind={parentKind}
                tabIndex={index === Math.min(active, launches.length - 1) ? 0 : -1}
                onKeyDown={(event) => onKeyDown(event, index)}
              />
            </div>
          ))}
        </div>
      </DisclosureRegion>
    </div>
  )
})
