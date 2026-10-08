import { useEffect, useMemo, useRef } from "react"

import { Button } from "@/components/kit/button"
import { FileEntryIcon } from "@/components/kit/chat/FileEntryIcon"
import { DiffStat } from "@/components/kit/diff-stat"
import { IconButton } from "@/components/kit/icon-button"
import { Textarea } from "@/components/kit/textarea"
import {
  FileDiffBody,
  FileDiffHeader,
  type DiffAnnotation,
} from "@/components/kybern/DiffView"
import { basename } from "@/lib/format"
import { truncateMiddle } from "@/lib/format"
import { ChevronLeftIcon, ChevronRightIcon, ExternalLinkIcon } from "@/lib/kit/icons"
import { openExternal } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import type { PrInlineComment, ProjectId } from "@/protocol"
import { loadReview, updateReview, updateReviewDraft } from "@/state/prReview"

import { prFileDiff } from "./prDiff"
import { PR_FINE_TEXT, PR_META_TEXT, PR_QUIET_INK } from "./prText"
import type { PrActions } from "./usePrActions"

const PAGE_SIZE = 30

const sideText = (side: string) => (side === "LEFT" ? "original" : "new")

function InlineComposer({
  anchor,
  mode,
  number,
  full,
  onChange,
  onCancel,
  onSave,
}: {
  anchor: PrInlineComment
  mode: "page" | "dock"
  number: number
  full: boolean
  onChange: (body: string) => void
  onCancel: () => void
  onSave: () => void
}) {
  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    input.current?.focus()
  }, [])
  const id = `inline-${mode}-${number}`
  return (
    <div className="pr-diff-card m-2 flex flex-col gap-2 rounded-lg border border-[color:var(--color-border)] bg-[var(--color-background-elevated-secondary)] p-2.5">
      <label htmlFor={id} className={cn("font-medium break-all", PR_META_TEXT)}>
        Comment on line {anchor.line} · {sideText(anchor.side)} version
      </label>
      <Textarea
        ref={input}
        id={id}
        value={anchor.body}
        maxLength={65536}
        onChange={(e) => onChange(e.target.value)}
        className="[&_textarea]:min-h-[4.5rem] [&_textarea]:leading-relaxed"
      />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!anchor.body.trim() || full} onClick={onSave}>
          Add to review
        </Button>
      </div>
    </div>
  )
}

function DraftCard({
  comment,
  onRemove,
}: {
  comment: PrInlineComment
  onRemove: () => void
}) {
  return (
    <div className="pr-diff-card m-2 flex flex-col gap-1.5 rounded-lg border border-[color:var(--color-border)] bg-[var(--color-background-elevated-secondary)]/60 p-2.5">
      <div className={cn("flex items-center gap-2", PR_FINE_TEXT)}>
        <span className="rounded-full bg-[var(--color-background-button-secondary)] px-1.5 py-px font-medium">
          Draft
        </span>
        <span className={PR_QUIET_INK}>
          line {comment.line} · {sideText(comment.side)}
        </span>
        <Button variant="ghost" size="xs" className="ms-auto" onClick={onRemove}>
          Remove
        </Button>
      </div>
      <p className={cn("break-words whitespace-pre-wrap", PR_META_TEXT)}>{comment.body}</p>
    </div>
  )
}

export function PrChangesTab({
  actions,
  stateKey,
  projectId,
  number,
  mode,
}: {
  actions: PrActions
  stateKey: string
  projectId: ProjectId
  number: number
  mode: "page" | "dock"
}) {
  const { review, detail, draft, staleDraft, setActionError } = actions
  const files = useMemo(() => review?.page?.files ?? [], [review?.page?.files])
  const file = files.find((f) => f.path === review?.file)
  const page = review?.page?.page ?? 1
  const fileDiff = useMemo(() => (file ? prFileDiff(file) : null), [file])
  const anchor =
    draft.pendingInline && draft.pendingInline.path === file?.path
      ? draft.pendingInline
      : null
  const draftPaths = useMemo(
    () => new Set(draft.inline.map((c) => c.path)),
    [draft.inline]
  )

  const annotations = useMemo<DiffAnnotation[]>(() => {
    if (!file) return []
    const out: DiffAnnotation[] = []
    draft.inline.forEach((comment, index) => {
      if (comment.path !== file.path) return
      out.push({
        key: `draft:${index}`,
        line: comment.line,
        side: comment.side === "LEFT" ? "LEFT" : "RIGHT",
        node: (
          <div
            className="sticky start-0"
            style={{ width: "min(44rem, var(--pr-diff-viewport, 100%))" }}
          >
            <DraftCard
              comment={comment}
              onRemove={() =>
                updateReviewDraft(stateKey, {
                  inline: draft.inline.filter((_, i) => i !== index),
                })
              }
            />
          </div>
        ),
      })
    })
    if (anchor)
      out.push({
        key: "pending",
        line: anchor.line,
        side: anchor.side === "LEFT" ? "LEFT" : "RIGHT",
        node: (
          <div
            className="sticky start-0"
            style={{ width: "min(44rem, var(--pr-diff-viewport, 100%))" }}
          >
            <InlineComposer
              anchor={anchor}
              mode={mode}
              number={number}
              full={draft.inline.length >= 100}
              onChange={(body) =>
                updateReviewDraft(stateKey, { pendingInline: { ...anchor, body } })
              }
              onCancel={() => updateReviewDraft(stateKey, { pendingInline: null })}
              onSave={() =>
                updateReviewDraft(stateKey, {
                  inline: [...draft.inline, anchor],
                  pendingInline: null,
                })
              }
            />
          </div>
        ),
      })
    return out
  }, [file, draft.inline, anchor, mode, number, stateKey])

  const total = detail?.changed_files ?? 0
  const first = (page - 1) * PAGE_SIZE + 1
  const go = (next: number) =>
    void loadReview(projectId, number, "files", next)

  return (
    <div className="pr-changes">
      <div className="pr-changes-files" aria-label="Changed files">
        <div className={cn("flex items-center gap-1 px-2 pb-1", PR_FINE_TEXT, PR_QUIET_INK)}>
          <span className="min-w-0 flex-1 truncate tabular-nums">
            {files.length
              ? `${total || files.length} files · ${first}–${first + files.length - 1}`
              : `${total} files`}
          </span>
          <IconButton
            size="icon-xs"
            label="Previous page"
            tooltip="Previous page"
            disabled={review?.loading || page <= 1}
            onClick={() => go(page - 1)}
          >
            <ChevronLeftIcon className="size-3.5 rtl:rotate-180" />
          </IconButton>
          <IconButton
            size="icon-xs"
            label="Next page"
            tooltip="Next page"
            disabled={review?.loading || !review?.page?.has_more}
            onClick={() => go(page + 1)}
          >
            <ChevronRightIcon className="size-3.5 rtl:rotate-180" />
          </IconButton>
        </div>
        {files.map((f) => {
          const name = basename(f.path)
          const dir = f.path.slice(0, f.path.length - name.length)
          const selected = file?.path === f.path
          return (
            <button
              key={f.path}
              type="button"
              aria-label={f.path}
              aria-pressed={selected}
              title={f.path}
              onClick={() => updateReview(stateKey, { file: f.path })}
              className={cn(
                "flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-start outline-none hover:bg-[var(--color-background-elevated-secondary)] focus-visible:ring-1 focus-visible:ring-ring",
                selected &&
                  "bg-[color-mix(in_srgb,var(--color-text-foreground)_7%,transparent)]"
              )}
            >
              <FileEntryIcon
                pathValue={f.path}
                kind="file"
                className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70"
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className={cn("truncate font-medium", PR_META_TEXT)}>{name}</span>
                  {draftPaths.has(f.path) && (
                    <span
                      aria-label="Has inline drafts"
                      role="img"
                      className="size-1.5 shrink-0 rounded-full bg-[var(--color-border-focus)]"
                    />
                  )}
                </span>
                {dir && (
                  <span
                    className={cn("block truncate", PR_FINE_TEXT, PR_QUIET_INK)}
                    style={{ direction: "rtl", textAlign: "start" }}
                  >
                    <bdi>{truncateMiddle(dir, 48)}</bdi>
                  </span>
                )}
              </span>
              <DiffStat
                className={cn("shrink-0", PR_FINE_TEXT)}
                insertions={f.additions}
                deletions={f.deletions}
              />
            </button>
          )
        })}
      </div>
      <div className="pr-changes-diff min-w-0">
        {file && fileDiff && (
          <div
            data-pr-diff={file.path}
            key={file.path}
            className="min-w-0 overflow-hidden rounded-lg border border-[color:var(--color-border)]"
          >
            <FileDiffHeader
              file={fileDiff}
              trailing={
                detail && (
                  <IconButton
                    size="icon-xs"
                    label="Open file on GitHub"
                    tooltip="Open file on GitHub"
                    onClick={() => void openExternal(`${detail.pull_request.url}/files`)}
                  >
                    <ExternalLinkIcon className="size-3.5" />
                  </IconButton>
                )
              }
            />
            <FileDiffBody
              file={fileDiff}
              annotations={annotations}
              onLineSelect={(line, side) => {
                if (staleDraft) {
                  setActionError(
                    "This draft belongs to a different commit. Resolve the previous draft before choosing a new inline anchor."
                  )
                  return
                }
                updateReviewDraft(stateKey, {
                  pendingInline: { path: file.path, line, side, body: "" },
                })
              }}
            />
            {file.patch_truncated && (
              <p className={cn("border-t border-[color:var(--color-border-light)] p-3 text-muted-foreground", PR_FINE_TEXT)}>
                GitHub omitted or truncated this patch. Open the pull request on
                GitHub to read the full file.
              </p>
            )}
          </div>
        )}
        {!files.length && (
          <p className="text-muted-foreground">
            {review?.loading ? "Loading changes…" : "No changed files on this page."}
          </p>
        )}
      </div>
    </div>
  )
}
