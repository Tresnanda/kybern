// Transcript pane, to Synara's ChatTranscriptPane / MessagesTimeline spec:
// centered 46rem column, user bubbles at 80% width, "Worked for" disclosure
// with a hairline, quiet work rows, markdown answer with a tiny action footer,
// and the "Edited N files" card.

import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { toast } from "sonner"

import { FileDiffBody } from "@/components/kybern/DiffView"
import { CHAT_COLUMN_GUTTER } from "./chatLayout"
import { Markdown } from "@/components/kybern/Markdown"
import { parseUnifiedDiff, type FileDiff } from "@/lib/diff"
import { Spinner } from "@/components/kybern/bits"
import { DisclosureChevron } from "@/components/synara/DisclosureChevron"
import { DisclosureRegion } from "@/components/synara/DisclosureRegion"
import { DiffStatLabel } from "@/components/synara/chat/DiffStatLabel"
import { MessageActionButton } from "@/components/synara/chat/MessageActionButton"
import { ReviewChangesButton } from "@/components/synara/chat/ReviewChangesButton"
import { clockTime, duration, elapsedSince, outputText, plural, toolLine } from "@/lib/format"
import { copyText, useTicker } from "@/lib/hooks"
import { MessageScroller } from "@/components/beui/message-scroller"
import {
  ArrowDownIcon,
  BotIcon,
  BrainIcon,
  ChangesIcon,
  CheckIcon,
  CircleAlertIcon,
  CopyIcon,
  FileIcon,
  HammerIcon,
  PanelRightCloseIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  Undo2Icon,
  WebSearchIcon,
} from "@/lib/synara/icons"
import { cn } from "@/lib/utils"
import type { ContentPart, Diff, ThreadId } from "@/protocol"
import { errorText, revertTo } from "@/state/rpc"
import { diffKey, useStore } from "@/state/store"
import { groupTurns, type Block, type TurnGroup } from "@/state/transcript"

const TEXT: CSSProperties = { fontSize: 12, lineHeight: "19.5px" }
const META: CSSProperties = { fontSize: 10, lineHeight: "16.25px" }
// No horizontal inset: message edges sit exactly on the composer's edges.
const ROW = "mx-auto w-full min-w-0 max-w-[var(--app-chat-max-width,46rem)] transition-colors duration-500"
const HOVER_REVEAL =
  "opacity-0 transition-opacity pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto"

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

export function Transcript({ threadId, bottomInset }: { threadId: ThreadId; bottomInset: number }) {
  const state = useStore((s) => s.transcripts[threadId])
  const blocks = state?.blocks
  const groups = useMemo(() => groupTurns(blocks ?? []), [blocks])
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
    <div data-chat-transcript-pane className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <MessageScroller
          navigation="rail"
          navigationLabel="Message navigation"
          navigationSide="left"
          followOutput
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
            groups.map((g, i) => <Turn key={g.turnId || i} group={g} threadId={threadId} isLast={i === groups.length - 1} />)
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
    </div>
  )
}

const Turn = memo(function Turn({ group, threadId, isLast }: { group: TurnGroup; threadId: ThreadId; isLast: boolean }) {
  const expanded = useStore((s) => s.expandedWork[group.turnId])
  const toggle = useStore((s) => s.toggleWork)
  const diff = useStore((s) => s.diffs[diffKey(threadId, group.turnId)])
  const hasWork = group.work.length > 0
  const settled = !group.running
  const open = group.running || !!expanded
  const streaming = group.running && !!group.answerLive

  return (
    <>
      {group.user && (
        <div className={cn(ROW, "pb-4")} data-timeline-row-kind="message" data-message-role="user" data-slot="message" data-from="user">
          <UserBubble message={group.user.message} at={group.user.at} />
        </div>
      )}

      {group.running && (
        <div className={cn(ROW, "pb-2")} data-timeline-row-kind="working-header">
          <WorkingHeader since={group.user?.at ?? ""} />
        </div>
      )}

      {group.running && hasWork && (
        <div className={cn(ROW, "pb-2")} data-timeline-row-kind="work">
          <div className="space-y-0.5">
            {group.work.map((b) => (
              <WorkRow key={b.id} block={b} />
            ))}
          </div>
        </div>
      )}

      {group.running && !streaming && (
        <div className={cn(ROW, "pb-1")} data-timeline-row-kind="working">
          <div className="shimmer pt-0.5 font-system-ui text-muted-foreground" style={{ fontSize: 12 }}>
            Thinking
          </div>
        </div>
      )}

      {(settled || streaming) && (
        <div className={cn(ROW, "group/assistant", streaming ? "pb-1" : "pb-2")} data-timeline-row-kind="message" data-message-role="assistant" data-slot="message" data-from="assistant">
          {settled && hasWork && (
            <div className="mb-3">
              <div className="group/collapsed-work">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => toggle(group.turnId)}
                  className="-ml-0.5 inline-flex items-center gap-1 pb-2 text-left text-muted-foreground transition-colors duration-200 hover:text-foreground"
                  style={{ fontSize: 12 }}
                >
                  <span>{group.end ? `Worked for ${clockDuration(group.end.durationMs)}` : "Details"}</span>
                  <DisclosureChevron open={open} className="text-muted-foreground/70" />
                </button>
                <DisclosureRegion open={open} contentClassName="mb-2.5 space-y-1.5">
                  {group.work.map((b) => (
                    <WorkRow key={b.id} block={b} />
                  ))}
                </DisclosureRegion>
              </div>
              <div className="h-px w-full bg-border" />
            </div>
          )}

          <div className="group min-w-0 py-0.5">
            {(group.answer ?? group.answerLive) && (
              <div data-slot="message-content">
                <Markdown text={(group.answer ?? group.answerLive)!.text} style={TEXT} />
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

function WorkingHeader({ since }: { since: string }) {
  const now = useTicker(true)
  return (
    <>
      <div className="-ml-0.5 pb-2 text-muted-foreground" style={{ fontSize: 12 }}>
        Working for {clockDuration(elapsedSince(since, now))}
      </div>
      <div className="h-px w-full bg-border" />
    </>
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
    <div className={cn("flex w-full flex-col gap-3", fresh && "chat-message-send-enter")}>
      <div className="flex w-full justify-end">
        <div className="group flex max-w-[80%] flex-col items-end gap-px">
          {files.length > 0 && (
            <div className="mb-1 flex max-w-[240px] flex-wrap justify-end gap-2 self-end">
              {files.map((p, i) =>
                p.type === "image" ? (
                  <img key={i} src={`data:${p.media_type};base64,${p.data}`} alt="" className="size-15 rounded-xl border border-border/70 object-cover" />
                ) : (
                  <span
                    key={i}
                    className="inline-flex h-7 max-w-[16rem] min-w-0 items-center gap-1.5 rounded-full border border-[color:var(--color-border)] bg-[var(--composer-surface)] px-2 text-[11px] font-medium text-[var(--color-text-foreground)]"
                  >
                    <FileIcon className="size-3.5 shrink-0 text-muted-foreground/90" />
                    <span className="min-w-0 truncate">{p.type === "attachment" ? p.name : p.path}</span>
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
          <div className="flex items-center justify-end gap-2 pr-0.5 font-system-ui font-normal text-muted-foreground/45" style={META}>
            <p className={cn("tabular-nums", HOVER_REVEAL)}>{clockTime(at)}</p>
            <div className={cn("flex items-center gap-2", HOVER_REVEAL)}>
              <CopyAction text={text} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function workIcon(verb: string, isError: boolean, complete: boolean) {
  if (!complete) return <Spinner size={14} className="text-muted-foreground" />
  if (isError) return <CircleAlertIcon className="size-4 text-muted-foreground/50" />
  switch (verb) {
    case "Ran":
      return <TerminalIcon className="size-4" />
    case "Edited":
    case "Wrote":
      return <PencilIcon className="size-4" />
    case "Read":
    case "Searched":
      return <SearchIcon className="size-4" />
    case "Fetched":
      return <WebSearchIcon className="size-4" />
    case "Delegated":
      return <BotIcon className="size-4" />
    default:
      return <HammerIcon className="size-4" />
  }
}

function workLabel(verb: string, detail: string, name: string): string {
  if (verb === "Ran") return detail ? `Ran ${detail}` : "Ran a command"
  if (verb === "Searched") return detail ? `Searched for ${detail}` : "Searched"
  if (verb === "Planned") return "Updated the plan"
  if (detail) return `${verb} ${detail}`
  return verb === name ? `Used ${name}` : verb
}

const TONE = "text-muted-foreground transition-colors group-hover/tool-row:text-foreground group-focus-visible/tool-row:text-foreground"

function WorkRow({ block }: { block: Block }) {
  switch (block.kind) {
    case "tool":
      return <ToolRow block={block} />
    case "assistant":
      return <AssistantWorkRow block={block} />
    case "approval":
      return (
        <div className="rounded-lg py-1">
          <div className="flex w-full items-center gap-2">
            <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
              {block.decision ? <CheckIcon className="size-4 text-muted-foreground/50" /> : <Spinner size={14} />}
            </span>
            <p className="truncate leading-6 text-muted-foreground" style={{ fontSize: 12 }}>
              {block.decision ? (block.decision.decision === "deny" ? "Declined " : "Approved ") : "Waiting to approve "}
              {block.approval.summary || block.approval.tool_name}
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
            <p className={cn("min-w-0 leading-6", block.level === "error" ? "text-destructive" : "text-muted-foreground")} style={{ fontSize: 12 }}>
              {block.text}
            </p>
          </div>
        </div>
      )
    default:
      return null
  }
}

function ToolRow({ block }: { block: Extract<Block, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false)
  const { verb, detail } = toolLine(block.call)
  const out = outputText(block.output, block.stream)
  const canOpen = out.trim().length > 0
  return (
    <div className="rounded-lg py-1">
      <button
        type="button"
        onClick={() => canOpen && setOpen((v) => !v)}
        aria-expanded={canOpen ? open : undefined}
        className={cn("group/tool-row flex w-full items-center gap-2 text-left transition-[opacity,translate] duration-200", canOpen ? "cursor-pointer focus-visible:outline-none" : "cursor-default")}
      >
        <span data-work-entry-icon className={cn("flex size-5 shrink-0 items-center justify-center", TONE)}>
          {workIcon(verb, block.isError, block.complete)}
        </span>
        <div className="min-w-0 overflow-hidden">
          <p className={cn("truncate leading-6", TONE)} style={{ fontSize: 12 }}>
            <span data-work-entry-display-text>{workLabel(verb, detail, block.call.name)}</span>
          </p>
        </div>
        {canOpen && <DisclosureChevron open={open} className="text-muted-foreground/70 group-hover/tool-row:text-foreground" />}
      </button>
      {canOpen && (
        <DisclosureRegion open={open} contentClassName="min-w-0 pt-2 ml-7">
          <pre className="selectable max-h-72 overflow-auto rounded-md bg-[var(--app-chat-code-surface)] px-2.5 py-2 font-chat-code text-[11px] leading-relaxed whitespace-pre-wrap break-words text-foreground/92">{out}</pre>
        </DisclosureRegion>
      )}
    </div>
  )
}

function AssistantWorkRow({ block }: { block: Extract<Block, { kind: "assistant" }> }) {
  const [open, setOpen] = useState(false)
  const hasThinking = block.thinking.trim().length > 0
  const hasText = block.text.trim().length > 0
  if (!hasThinking && !hasText) return null
  return (
    <>
      {hasThinking && (
        <div className="rounded-lg py-1">
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="group/tool-row flex w-full cursor-pointer items-center gap-2 text-left focus-visible:outline-none">
            <span className={cn("flex size-5 shrink-0 items-center justify-center", TONE)}>
              {block.complete ? <BrainIcon className="size-4" /> : <Spinner size={14} className="text-muted-foreground" />}
            </span>
            <div className="min-w-0 overflow-hidden">
              <p className={cn("truncate leading-6", TONE, !block.complete && "shimmer")} style={{ fontSize: 12 }}>
                {block.complete ? "Thought" : "Thinking"}
              </p>
            </div>
            <DisclosureChevron open={open} className="text-muted-foreground/70 group-hover/tool-row:text-foreground" />
          </button>
          <DisclosureRegion open={open} contentClassName="min-w-0 pt-2 ml-7">
            <p className="selectable whitespace-pre-wrap text-muted-foreground" style={TEXT}>
              {block.thinking}
            </p>
          </DisclosureRegion>
        </div>
      )}
      {hasText && (
        <div className="chat-message-segment flex flex-col gap-1.5 pr-[2px] pl-[2px]">
          <div className="text-muted-foreground">
            <Markdown text={block.text} className="[&_*]:text-muted-foreground" style={TEXT} />
          </div>
        </div>
      )}
    </>
  )
}

const MAX_VISIBLE_CHANGED_FILES = 5

function EditedFilesCard({ diff, threadId, turnId, canUndo }: { diff: Diff; threadId: ThreadId; turnId: string; canUndo: boolean }) {
  const [expanded, setExpanded] = useState(true)
  const [showAll, setShowAll] = useState(false)
  const [reverting, setReverting] = useState(false)
  const [openFiles, setOpenFiles] = useState<Record<string, boolean>>({})
  const set = useStore((s) => s.set)
  const parsed = useMemo(() => {
    const m = new Map<string, FileDiff>()
    for (const f of parseUnifiedDiff(diff.patch)) m.set(f.path, f)
    return m
  }, [diff.patch])
  const toggleFile = (path: string) => setOpenFiles((o) => ({ ...o, [path]: !o[path] }))
  const fileFor = (f: Diff["files"][number]): FileDiff =>
    parsed.get(f.path) ?? { path: f.path, oldPath: f.old_path ?? null, status: f.status === "added" ? "added" : f.status === "deleted" ? "deleted" : "modified", binary: f.binary, hunks: [], additions: f.additions, deletions: f.deletions }
  const adds = diff.files.reduce((n, f) => n + f.additions, 0)
  const dels = diff.files.reduce((n, f) => n + f.deletions, 0)
  const head = diff.files.slice(0, MAX_VISIBLE_CHANGED_FILES)
  const rest = diff.files.slice(MAX_VISIBLE_CHANGED_FILES)
  const review = () => set({ rightOpen: true, rightTab: "changes" })

  useEffect(() => {
    if (rest.length === 0) setShowAll(false)
  }, [rest.length])

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
          "flex items-center justify-between gap-3 bg-[color:color-mix(in_srgb,var(--app-user-message-background)_40%,transparent)] px-3 py-1.5",
          expanded && "border-b border-[color:var(--color-border-light)]",
        )}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <ChangesIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
          <div className="min-w-0">
            <div className="truncate font-normal text-foreground/92" style={{ fontSize: 12 }}>
              Edited {plural(diff.files.length, "file")}
            </div>
            {(adds > 0 || dels > 0) && (
              <div className="font-system-ui tabular-nums" style={{ fontSize: 12 }}>
                <DiffStatLabel additions={adds} deletions={dels} />
              </div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canUndo && (
            <button type="button" onClick={undo} disabled={reverting} className="flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground" style={{ fontSize: 12 }}>
              Undo {reverting ? <Spinner size={12} /> : <Undo2Icon className="size-3" />}
            </button>
          )}
          <ReviewChangesButton onClick={review} style={{ fontSize: 12 }} />
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
          <EditedFileRow key={f.path} file={fileFor(f)} first={i === 0} open={!!openFiles[f.path]} onToggle={() => toggleFile(f.path)} onReview={review} />
        ))}
        <DisclosureRegion open={showAll}>
          {rest.map((f) => (
            <EditedFileRow key={f.path} file={fileFor(f)} open={!!openFiles[f.path]} onToggle={() => toggleFile(f.path)} onReview={review} />
          ))}
        </DisclosureRegion>
        {rest.length > 0 && (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="flex w-full items-center justify-start gap-1.5 border-t border-[color:var(--color-border-light)] bg-transparent px-3 py-2 font-system-ui font-normal text-muted-foreground transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground"
            style={{ fontSize: 12 }}
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
function EditedFileRow({ file, first, open, onToggle, onReview }: { file: FileDiff; first?: boolean; open: boolean; onToggle: () => void; onReview: () => void }) {
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
          onClick={onToggle}
          className="group/file-row flex min-w-0 flex-1 items-center gap-2 self-stretch bg-transparent py-1 pl-3 text-left focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
        >
          <DisclosureChevron open={open} className="text-muted-foreground/60" />
          <FileIcon className="size-4 shrink-0 text-[var(--color-text-foreground)] opacity-70 dark:opacity-80" />
          <span className="min-w-0 truncate font-system-ui font-normal text-[var(--color-text-foreground)] underline-offset-2 group-hover/file-row:underline group-focus-visible/file-row:underline" style={{ fontSize: 12 }}>
            {file.path}
          </span>
          <span className="ml-auto shrink-0 font-system-ui tabular-nums" style={{ fontSize: 12 }}>
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
          <FileDiffBody file={file} />
        </div>
      </DisclosureRegion>
    </div>
  )
}
