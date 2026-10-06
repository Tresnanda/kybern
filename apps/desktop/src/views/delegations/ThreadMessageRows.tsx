// Messages between threads, as their own rows: an inbound message (sender, purpose, body), the
// card of delegated results a parent gets back, and the "Sent to" row on the sending side.
// Closed details unmount (DisclosureRegion); long bodies clamp behind "Show more".

import { memo, useMemo, useState, type ReactNode } from "react"

import {
  delegationState,
  messageSenderName,
  shortBranch,
  plainLine,
  purposeLabel,
  resultPreview,
  type ChildPhase,
} from "../../../../../packages/kybern-client/src/delegations.ts"
import { parseSendInput, parseSendResult, sendStateWord, type SendResult } from "../../../../../packages/kybern-client/src/orchestrationTools.ts"
import type { Block } from "../../../../../packages/kybern-client/src/transcript.ts"
import { Logo, ProviderMark } from "@/components/kybern/bits"
import { DisclosureChevron } from "@/components/kit/DisclosureChevron"
import { DisclosureRegion } from "@/components/kit/DisclosureRegion"
import { Button } from "@/components/kit/button"
import { getChatTranscriptTextStyle } from "@/components/kit/chat/chatTypography"
import { clockTime } from "@/lib/format"
import {
  ArrowUpRightIcon,
  ChatBubbleIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleQuestionIcon,
  ClockIcon,
  GitBranchIcon,
  HandRaisedIcon,
  ListChecksIcon,
  SteerIcon,
  TriangleAlertIcon,
  Undo2Icon,
} from "@/lib/kit/icons"
import { useTranscriptRowState } from "@/lib/transcriptRowState"
import { cn } from "@/lib/utils"
import type { AgentResultItem, ThreadMessagePart, ThreadMessagePurpose } from "@/protocol"
import { useStore } from "@/state/store"
import { openThreadView } from "@/state/subagents"
import { ClampedMarkdown, ConflictsList, DetailSection, FilesList, WorkspaceFacts } from "../lineage/detail"
import { ChildGlyph, Chip } from "../lineage/parts"
import { phaseWordClass } from "../lineage/phaseStyles"

const TEXT = getChatTranscriptTextStyle()
const CHAT_FONT = { fontSize: TEXT.fontSize }
type ToolBlock = Extract<Block, { kind: "tool" }>

/** Each purpose has its own shape, so the label is never the only difference. */
function PurposeIcon({ purpose, className }: { purpose: ThreadMessagePurpose; className?: string }) {
  const props = { className: cn("size-3.5", className), "aria-hidden": true as const }
  switch (purpose) {
    case "task":
      return <ListChecksIcon {...props} />
    case "question":
      return <CircleQuestionIcon {...props} />
    case "reply":
      return <Undo2Icon {...props} />
    case "warning":
      return <TriangleAlertIcon {...props} className={cn(props.className, "text-warning")} />
    default:
      return <ChatBubbleIcon {...props} />
  }
}

const CARD_CLASS = "min-w-0 rounded-xl bg-[var(--color-background-elevated-secondary)] px-3 py-2.5"
const SENDER_CHIP =
  "inline-flex h-5 min-w-0 max-w-[18rem] items-center gap-1 rounded-full px-1.5 text-xs leading-none text-foreground/85 [&_svg]:shrink-0"

// ---- inbound message ----

function SenderChip({ part }: { part: Pick<ThreadMessagePart, "from_thread_id" | "from_title"> }) {
  const name = messageSenderName(part)
  const from = part.from_thread_id
  const kind = useStore((state) => (from ? state.threads[from]?.provider.kind : undefined))
  if (!from) {
    return (
      <span className={cn(SENDER_CHIP, "bg-foreground/[0.06]")}>
        <Logo size={11} className="text-foreground/70" />
        <span className="truncate">Kybern</span>
      </span>
    )
  }
  return (
    <button
      type="button"
      title={`Open ${name}`}
      aria-label={`Open ${name}`}
      onClick={() => openThreadView(from)}
      className={cn(SENDER_CHIP, "cursor-pointer bg-foreground/[0.06] outline-hidden transition-colors hover:bg-foreground/[0.1] focus-visible:ring-2 focus-visible:ring-ring/60")}
    >
      {kind && <ProviderMark kind={kind} size={11} className="size-[11px]" />}
      <span className="truncate">{name}</span>
    </button>
  )
}

/** The question a reply answers, found among this thread's own "Sent to" calls. */
function useRepliedTo(threadId: string | null, replyTo: string | null | undefined): string | null {
  // Read once: the question was sent before its reply could arrive, so it never changes.
  const [quoted] = useState(() => {
    if (!threadId || !replyTo) return null
    const blocks = useStore.getState().transcripts[threadId]?.blocks
    if (!blocks) return null
    for (let index = blocks.length - 1; index >= 0; index--) {
      const block = blocks[index]!
      if (block.kind !== "tool" || !block.complete) continue
      if (parseSendResult(block.output)?.messageId !== replyTo) continue
      return plainLine(parseSendInput(block.call.input).body, 56)
    }
    return null
  })
  return quoted
}

/** "Reply to “…”": a link to the "Sent to" row of the question, when that row is mounted. */
function ReplyLink({ replyTo, quoted }: { replyTo: string; quoted: string | null }) {
  const text = quoted ? `Reply to “${quoted}”` : "Reply to your question"
  if (!quoted) return <p className="mt-1.5 min-w-0 truncate text-xs text-foreground/55">{text}</p>
  return (
    <button
      type="button"
      onClick={() => document.querySelector(`[data-sent-message-id="${CSS.escape(replyTo)}"]`)?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })}
      className="mt-1.5 block max-w-full cursor-pointer truncate rounded-md text-start text-xs text-foreground/55 underline-offset-2 outline-hidden hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      {text}
    </button>
  )
}

/** A `thread_message` part. The sender chip opens the sender; a reply names the question it answers. */
export const InboundMessageRow = memo(function InboundMessageRow({ part, at, threadId }: { part: ThreadMessagePart; at: string; threadId: string | null }) {
  const label = purposeLabel(part.purpose)
  const quoted = useRepliedTo(threadId, part.reply_to)
  return (
    <div className={cn(CARD_CLASS, "my-3")} data-inbound-message={part.purpose} data-message-id={part.message_id}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-foreground/80">
          <PurposeIcon purpose={part.purpose} className="text-foreground/60" />
          {label}
        </span>
        <span aria-hidden className="text-xs text-foreground/35">from</span>
        <span className="sr-only">from</span>
        <SenderChip part={part} />
        <time dateTime={at} title={new Date(at).toLocaleString()} className="ms-auto shrink-0 text-[11px] tabular-nums text-foreground/40">{clockTime(at)}</time>
      </div>
      {part.reply_to && <ReplyLink replyTo={part.reply_to} quoted={quoted} />}
      {part.body.trim() && (
        <div className="mt-2 min-w-0 text-foreground">
          <ClampedMarkdown text={part.body} fontSize={13} variant="user" />
        </div>
      )}
    </div>
  )
})

// ---- results card ----

function ResultItemRow({ item, at }: { item: AgentResultItem; at: string }) {
  const [open, setOpen] = useTranscriptRowState<boolean>(`result:${item.task_id}`, false)
  const state = delegationState(item.status)
  const preview = resultPreview(item)
  const files = item.files_touched?.length ?? 0
  const conflicts = item.conflicts?.length ?? 0
  const worktree = item.workspace === "worktree"
  const live = useStore((s) => s.threads[item.thread_id])
  return (
    <li className="min-w-0" data-agent-result={item.task_id}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="group/ri flex w-full min-w-0 cursor-pointer items-start gap-2.5 rounded-lg py-2 text-start outline-hidden focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <span className="sa-avatar sa-avatar--single mt-px shrink-0" aria-hidden>
          <ProviderMark kind={item.provider} size={12} className="size-3" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-[13px] leading-5 text-foreground/90" title={item.title}>{item.title}</span>
            <span className="inline-flex shrink-0 items-center gap-1.5 text-xs">
              <ChildGlyph phase={state.phase as ChildPhase} />
              <span className={phaseWordClass(state.phase)}>{state.word}</span>
            </span>
          </span>
          {preview && <span className={cn("min-w-0 truncate text-xs leading-5", item.status === "failed" || item.status === "interrupted" ? "text-destructive/85" : "text-foreground/55")} title={preview}>{preview}</span>}
          <span className="flex min-w-0 flex-wrap items-center gap-1 pt-0.5 empty:hidden">
            {worktree && item.branch && <Chip icon={<GitBranchIcon />} title={item.branch}>{shortBranch(item.branch)}</Chip>}
            {worktree && item.diffstat ? <Chip>{`${item.diffstat.files} ${item.diffstat.files === 1 ? "file" : "files"} · +${item.diffstat.additions} −${item.diffstat.deletions}`}</Chip> : files > 0 ? <Chip>{`${files} ${files === 1 ? "file" : "files"}`}</Chip> : null}
            {conflicts > 0 && <Chip tone="warning" icon={<TriangleAlertIcon className="text-warning" />}>{`${conflicts} ${conflicts === 1 ? "conflict" : "conflicts"}`}</Chip>}
          </span>
        </span>
        <DisclosureChevron open={open} className="mt-1 size-3 shrink-0 text-foreground/45 transition-colors group-hover/ri:text-foreground/80" />
      </button>
      <DisclosureRegion open={open}>
        <div className="flex min-w-0 flex-col gap-3 pb-3 ps-[30px] pe-1">
          {item.error && (
            <DetailSection label="Error">
              <p className="selectable text-xs leading-5 break-words text-destructive/90">{item.error}</p>
            </DetailSection>
          )}
          {item.result?.trim() ? (
            <DetailSection label="Result">
              <ClampedMarkdown text={item.result} />
            </DetailSection>
          ) : (
            !item.error && <p className="text-xs leading-5 text-foreground/55">This agent finished without a summary.</p>
          )}
          <WorkspaceFacts info={item} />
          <FilesList files={item.files_touched ?? []} />
          <ConflictsList conflicts={item.conflicts} />
          <div className="flex items-center gap-1.5">
            <Button variant="subtle" size="chip" onClick={() => openThreadView(item.thread_id)}>
              <ArrowUpRightIcon /> Open
            </Button>
            {live?.status === "archived" && <span className="text-xs text-foreground/50">Archived</span>}
            <time dateTime={at} className="sr-only">{clockTime(at)}</time>
          </div>
        </div>
      </DisclosureRegion>
    </li>
  )
}

/** The batched results a delegating thread gets back: one row per agent, expandable to its full result. */
export const AgentResultsCard = memo(function AgentResultsCard({ items, at }: { items: readonly AgentResultItem[]; at: string }) {
  const counts = useMemo(() => {
    let failed = 0
    for (const item of items) if (item.status === "failed" || item.status === "interrupted") failed += 1
    return failed
  }, [items])
  const title = items.length === 1 ? "Result from 1 delegated agent" : `Results from ${items.length} delegated agents`
  return (
    <section aria-label={title} className={cn(CARD_CLASS, "my-3")} data-agent-results="">
      <div className="flex min-w-0 items-center gap-2">
        <CheckIcon className="size-3.5 shrink-0 text-foreground/60" aria-hidden />
        <h3 className="min-w-0 flex-1 truncate text-xs font-medium text-foreground/80">{title}</h3>
        {counts > 0 && <span className="shrink-0 text-xs text-destructive">{counts} {counts === 1 ? "needs a look" : "need a look"}</span>}
        <time dateTime={at} title={new Date(at).toLocaleString()} className="shrink-0 text-[11px] tabular-nums text-foreground/40">{clockTime(at)}</time>
      </div>
      <ul className="mt-1 flex flex-col divide-y divide-[color:var(--color-border)]">
        {items.map((item) => <ResultItemRow key={item.task_id} item={item} at={at} />)}
      </ul>
    </section>
  )
})

// ---- "Sent to" ----

function sendGlyph(result: SendResult | null, complete: boolean, isError: boolean): ReactNode {
  const props = { className: "size-3", "aria-hidden": true as const }
  if (isError) return <CircleAlertIcon {...props} className="size-3 text-destructive" />
  if (!complete) return <ClockIcon {...props} />
  if (result?.reply || result?.state === "answered") return <CheckIcon {...props} />
  switch (result?.state) {
    case "held":
      return <HandRaisedIcon {...props} className="size-3 text-amber-600 dark:text-amber-300/90" />
    case "steered":
      return <SteerIcon {...props} />
    case "failed":
      return <CircleAlertIcon {...props} className="size-3 text-destructive" />
    default:
      return <ClockIcon {...props} />
  }
}

/** A `kybern_thread_send` call: who it went to, what it said, and where it stands. */
export const SentToRow = memo(function SentToRow({ block, legacy }: { block: ToolBlock; legacy: ReactNode }) {
  const input = useMemo(() => parseSendInput(block.call.input), [block.call.input])
  const result = useMemo(() => (block.complete ? parseSendResult(block.output) : null), [block.complete, block.output])
  const target = useStore((state) => (input.threadId ? state.threads[input.threadId] : undefined))
  const [open, setOpen] = useTranscriptRowState<boolean>("sent-to", false)
  if (!input.threadId || !input.body) return legacy
  const title = target?.title || "another thread"
  const word = sendStateWord(result, block.complete, block.isError)
  const held = result?.state === "held"
  const failed = block.isError || result?.state === "failed"
  const preview = plainLine(input.body, 160)
  const replyPreview = result?.reply ? plainLine(result.reply.body, 160) : ""
  const label = `Sent ${purposeLabel(input.purpose).toLowerCase()} to ${title}, ${word}`
  return (
    <div className="rounded-lg py-1" data-sent-to={input.purpose} data-sent-message-id={result?.messageId}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((value) => !value)}
        className="group/st flex w-full min-w-0 cursor-pointer items-center gap-1.5 text-start outline-hidden focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground transition-colors group-hover/st:text-foreground">
          <PurposeIcon purpose={input.purpose} />
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 leading-6 text-muted-foreground transition-colors group-hover/st:text-foreground" style={CHAT_FONT}>
          <span className="shrink-0">{block.complete ? "Sent to" : "Sending to"}</span>
          {target && <ProviderMark kind={target.provider.kind} size={12} className="size-3 shrink-0" />}
          <span className="min-w-0 truncate" title={title}>{title}</span>
          <span className="shrink-0 text-foreground/40">· {purposeLabel(input.purpose)}</span>
        </span>
        <span className={cn("inline-flex shrink-0 items-center gap-1 text-xs", failed ? "text-destructive" : held ? "text-amber-700 dark:text-amber-300/90" : "text-foreground/55")}>
          {sendGlyph(result, block.complete, block.isError)}
          {word}
        </span>
        <DisclosureChevron open={open} className="size-3 text-muted-foreground/65 group-hover/st:text-foreground" />
      </button>
      <div className="ms-[1.375rem] flex min-w-0 flex-col gap-0.5">
        <p className="min-w-0 truncate text-xs leading-5 text-foreground/50" title={preview}>“{preview}”</p>
        {replyPreview && (
          <p className="flex min-w-0 items-center gap-1.5 text-xs leading-5 text-foreground/70" title={replyPreview}>
            <Undo2Icon className="size-3 shrink-0 text-foreground/45" aria-hidden />
            <span className="min-w-0 truncate">Reply: “{replyPreview}”</span>
          </p>
        )}
        {held && (
          <p className="flex min-w-0 items-center gap-2 text-xs leading-5 text-foreground/70">
            <span className="min-w-0 truncate">Waiting for you to approve it in {title}.</span>
            {input.threadId && (
              <button type="button" onClick={() => openThreadView(input.threadId)} className="shrink-0 cursor-pointer rounded-md px-1 text-foreground/80 underline-offset-2 outline-hidden hover:underline focus-visible:ring-2 focus-visible:ring-ring/60">Open</button>
            )}
          </p>
        )}
      </div>
      <DisclosureRegion open={open} contentClassName="ms-[1.375rem] min-w-0 pt-1.5">
        <div className="flex min-w-0 flex-col gap-3 pb-1">
          <DetailSection label="Message">
            <ClampedMarkdown text={input.body} variant="user" />
          </DetailSection>
          {result?.reply && (
            <DetailSection label="Reply">
              <ClampedMarkdown text={result.reply.body} />
            </DetailSection>
          )}
          {result?.waitTimedOut && <p className="text-xs text-foreground/55">No reply yet. It will arrive here when the thread answers.</p>}
          {target && (
            <div>
              <Button variant="subtle" size="chip" onClick={() => openThreadView(target.id)}>
                <ArrowUpRightIcon /> Open
              </Button>
            </div>
          )}
        </div>
      </DisclosureRegion>
    </div>
  )
})
