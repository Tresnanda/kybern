// The cards a Coordinator raises over the composer, stacked like other approvals:
// - "Save this as the project brief?": the proposed text, editable, saved with ⌘↵.
// - "Apply these Coordinator settings?": old → new rows the user can untick.
// - Git: push, push and open a pull request, or merge one. Push and open PR answer like a
//   permission (1 allows, 3 declines); merging a PR has no digit and a destructive button.
// Words and input parsing live in `packages/kybern-client/src/coordinatorCards.ts`.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react"

import { Button } from "@/components/kit/button"
import { Checkbox } from "@/components/kit/checkbox"
import { ComposerStackedPanel } from "@/components/kit/chat/ComposerStackedPanel"
import { Textarea } from "@/components/kit/textarea"
import { TextSwap } from "@/components/kybern/motion"
import { mod } from "@/lib/format"
import { GitMergeIcon, GitPullRequestIcon, NoteIcon, PushIcon, SettingsIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import { RpcCallError, type ApprovalDecision, type ApprovalRequest, type BriefProposalInput, type LeadGitCardInput, type SettingsProposalInput } from "@/protocol"
import { respondApproval } from "@/state/rpc"
import { useStore } from "@/state/store"
import { COORDINATOR_CARD_COPY, checksLabel, gitCardCopy, mergeMethodLabel } from "../../../../../packages/kybern-client/src/coordinatorCards"
import { settingValueLabel } from "../../../../../packages/kybern-client/src/coordinatorSettings"
import { CardText } from "./CoordinatorRows"

/** The count chip when more than one approval waits. */
function QueueCount({ count }: { count: number }) {
  if (count <= 1) return null
  return (
    <span className="mt-px flex h-4 shrink-0 items-center rounded bg-[var(--color-background-elevated-secondary)] px-1 text-[9.5px] font-medium text-[var(--color-text-foreground-secondary)] tabular-nums">
      1/{count}
    </span>
  )
}

/** Icon tile, title and the line under it: the shared top of every Coordinator card. */
function CardHeader({ icon, titleId, detailId, title, detail, count }: { icon: ReactNode; titleId: string; detailId: string; title: ReactNode; detail?: ReactNode; count: number }) {
  return (
    <div className="flex items-start gap-3">
      <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-background-elevated-secondary)] text-muted-foreground">
        {icon}
      </span>
      <div className="min-w-0 flex-1 pt-px">
        <p id={titleId} className="flex items-start gap-2 text-[13px] leading-snug font-medium text-balance text-foreground/90">
          <span className="min-w-0 break-words">{title}</span>
          <QueueCount count={count} />
        </p>
        {detail && <div id={detailId} className="mt-0.5 text-[12px] leading-relaxed text-pretty text-muted-foreground/65">{detail}</div>}
      </div>
    </div>
  )
}

/** Answer once; a refusal or a lost connection stays on the card with what to do next. */
function useRespond(approvalId: string) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const respond = async (decision: ApprovalDecision) => {
    if (busy) return
    setBusy(true)
    setError("")
    try {
      await respondApproval(approvalId, decision)
    } catch (failure) {
      setError(failure instanceof RpcCallError ? failure.message : COORDINATOR_CARD_COPY.answerFailed)
      setBusy(false)
    }
  }
  return { busy, error, respond }
}

function CardError({ error }: { error: string }) {
  return error ? <p role="alert" className="mt-1.5 text-[12px] leading-relaxed text-destructive">{error}</p> : null
}

/** "Save this as the project brief?" with the Coordinator's text, which the user edits before saving. */
export function BriefProposalPanel({ approval, input, count }: { approval: ApprovalRequest; input: BriefProposalInput; count: number }) {
  const field = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState(input.text)
  const { busy, error, respond } = useRespond(approval.id)
  const titleId = useId()
  const detailId = useId()
  const empty = !text.trim()
  // Nothing else on the card takes text; the cursor waits at the end of the proposal.
  useEffect(() => {
    const node = field.current
    if (!node) return
    node.focus({ preventScroll: true })
    node.setSelectionRange(node.value.length, node.value.length)
  }, [])
  const save = () => {
    if (empty) {
      field.current?.focus()
      return
    }
    void respond({ decision: "submit", response: { text } })
  }
  return (
    <ComposerStackedPanel className="composer-approval-panel t-panel-enter px-3.5 py-3" role="group" aria-labelledby={titleId} aria-describedby={detailId} data-coordinator-card="brief">
      <CardHeader
        icon={<NoteIcon className="size-4" />}
        titleId={titleId}
        detailId={detailId}
        count={count}
        title={input.replaces ? COORDINATOR_CARD_COPY.briefReplaceTitle : COORDINATOR_CARD_COPY.briefTitle}
        detail={COORDINATOR_CARD_COPY.briefDetail}
      />
      <Textarea
        ref={field}
        aria-label="Project brief"
        aria-invalid={empty || !!error || undefined}
        value={text}
        disabled={busy}
        spellCheck
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            save()
          } else if (event.key === "Escape") {
            event.preventDefault()
            event.currentTarget.blur()
          }
        }}
        className="mt-2.5 border-[var(--color-border)] bg-[var(--color-background-control-opaque)] text-[12.5px] leading-[1.55]"
        style={{ maxHeight: 200, overflowY: "auto" }}
      />
      {empty && <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground/70">{COORDINATOR_CARD_COPY.briefEmpty}</p>}
      <CardError error={error} />
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <p className="me-auto min-w-40 flex-1 text-[11px] leading-snug text-pretty text-muted-foreground/65">{COORDINATOR_CARD_COPY.briefFootnote}</p>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void respond({ decision: "deny" })}>{COORDINATOR_CARD_COPY.decline}</Button>
        <Button type="button" size="sm" disabled={busy || empty} onClick={save}>
          <TextSwap text={busy ? COORDINATOR_CARD_COPY.saving : COORDINATOR_CARD_COPY.briefSave} />
          <kbd className="text-[0.85em] opacity-60" aria-hidden="true">{mod}↵</kbd>
        </Button>
      </div>
    </ComposerStackedPanel>
  )
}

/** "Apply these Coordinator settings?": every change ticked to start; the user unticks what to keep. */
export function SettingsProposalPanel({ approval, input, count }: { approval: ApprovalRequest; input: SettingsProposalInput; count: number }) {
  const providers = useStore((s) => s.providers)
  const [accepted, setAccepted] = useState(() => new Set(input.changes.map((change) => change.path)))
  const { busy, error, respond } = useRespond(approval.id)
  const titleId = useId()
  const detailId = useId()
  const apply = () => {
    if (accepted.size === 0) return
    void respond({ decision: "submit", response: { accepted: input.changes.map((change) => change.path).filter((path) => accepted.has(path)) } })
  }
  const label = `Apply ${accepted.size} ${accepted.size === 1 ? "change" : "changes"}`
  return (
    <ComposerStackedPanel
      className="composer-approval-panel t-panel-enter px-3.5 py-3"
      role="group"
      aria-labelledby={titleId}
      aria-describedby={detailId}
      data-coordinator-card="settings"
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          apply()
        }
      }}
    >
      <CardHeader
        icon={<SettingsIcon className="size-4" />}
        titleId={titleId}
        detailId={detailId}
        count={count}
        title={COORDINATOR_CARD_COPY.settingsTitle}
        detail={<>{input.reason && <span className="block">{input.reason}</span>}<span className="block">{COORDINATOR_CARD_COPY.settingsDetail}</span></>}
      />
      <ul className="mt-2.5 divide-y divide-[color:var(--app-surface-divider)] overflow-hidden rounded-lg border border-[color:var(--app-surface-divider)]">
        {input.changes.map((change) => {
          const on = accepted.has(change.path)
          const oldText = settingValueLabel(change.path, change.old, providers)
          const newText = settingValueLabel(change.path, change.new, providers)
          return (
            <li key={change.path}>
              <label className="flex min-h-9 cursor-default items-center gap-2.5 px-2.5 py-1.5 text-[12px]" data-setting-change={change.path}>
                <Checkbox
                  checked={on}
                  disabled={busy}
                  onCheckedChange={(checked) =>
                    setAccepted((current) => {
                      const next = new Set(current)
                      if (checked) next.add(change.path)
                      else next.delete(change.path)
                      return next
                    })
                  }
                />
                <span className="w-36 min-w-0 shrink-0 truncate text-muted-foreground" title={change.label}>{change.label}</span>
                <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5">
                  <s className="text-muted-foreground decoration-muted-foreground/60">{oldText}</s>
                  <span aria-hidden className="text-muted-foreground">→</span>
                  <span className="sr-only">to</span>
                  <span className={cn("text-foreground/90", !on && "text-muted-foreground")}>{newText}</span>
                </span>
              </label>
            </li>
          )
        })}
      </ul>
      <CardError error={error} />
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void respond({ decision: "deny" })}>{COORDINATOR_CARD_COPY.decline}</Button>
        <Button type="button" size="sm" disabled={busy || accepted.size === 0} onClick={apply}>
          <TextSwap text={label} />
          <kbd className="text-[0.85em] opacity-60" aria-hidden="true">{mod}↵</kbd>
        </Button>
      </div>
    </ComposerStackedPanel>
  )
}

/**
 * Push, push and open a pull request, or merge one. The first two answer like any
 * permission, digits included; a merge has no digit and asks with a destructive button.
 */
export function GitApprovalPanel({ approval, input, count, onChoose }: { approval: ApprovalRequest; input: LeadGitCardInput; count: number; onChoose: (n: number) => void }) {
  const { busy, error, respond } = useRespond(approval.id)
  const titleId = useId()
  const detailId = useId()
  const copy = useMemo(() => gitCardCopy(input), [input])
  const merge = input.op === "merge_pr"
  const checks = merge ? checksLabel(input.checks) : null
  const icon = input.op === "push" ? <PushIcon className="size-4" /> : input.op === "open_pr" ? <GitPullRequestIcon className="size-4" /> : <GitMergeIcon className="size-4" />
  return (
    <ComposerStackedPanel className="composer-approval-panel t-panel-enter px-3.5 py-3" role="group" aria-labelledby={titleId} aria-describedby={detailId} data-coordinator-card={`git-${input.op}`}>
      <CardHeader icon={icon} titleId={titleId} detailId={detailId} count={count} title={<CardText parts={copy.title} />} detail={copy.detail.length ? <CardText parts={copy.detail} /> : undefined} />
      {input.op === "open_pr" && (input.title || input.body) && (
        <div className="mt-2.5 rounded-lg border border-[color:var(--app-surface-divider)] bg-[var(--color-background-control-opaque)] px-2.5 py-2 text-[12px]">
          {input.title && <p className="font-medium text-foreground/90 break-words">{input.title}</p>}
          {input.body && <p className="mt-0.5 line-clamp-3 leading-[1.5] break-words whitespace-pre-line text-muted-foreground">{input.body}</p>}
        </div>
      )}
      {merge && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {checks && (
            <span
              data-checks-tone={checks.tone}
              className={cn(
                "inline-flex h-5 items-center rounded-full px-2 text-[10.5px]",
                checks.tone === "ok" ? "bg-[color-mix(in_srgb,var(--color-success)_12%,transparent)] text-[var(--color-success)]"
                  : checks.tone === "bad" ? "bg-destructive/10 text-destructive"
                    : "bg-[var(--color-background-elevated-secondary)] text-muted-foreground",
              )}
            >
              {checks.text}
            </span>
          )}
          <span className="inline-flex h-5 items-center rounded-full bg-[var(--color-background-elevated-secondary)] px-2 text-[10.5px] text-muted-foreground">{mergeMethodLabel(input.method)}</span>
        </div>
      )}
      <CardError error={error} />
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {merge && <p className="me-auto min-w-40 flex-1 text-[11px] leading-snug text-pretty text-muted-foreground/65">{COORDINATOR_CARD_COPY.mergeWarning}</p>}
        <Button type="button" variant="chrome-outline" size="sm" disabled={busy} onClick={() => onChoose(3)}>
          {COORDINATOR_CARD_COPY.decline}<kbd className="text-[0.85em] opacity-60" aria-hidden="true">3</kbd>
        </Button>
        {merge ? (
          <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={() => void respond({ decision: "allow_once" })}>{copy.action}</Button>
        ) : (
          <Button type="button" size="sm" disabled={busy} onClick={() => onChoose(1)}>
            {copy.action}<kbd className="text-[0.85em] opacity-60" aria-hidden="true">1</kbd>
          </Button>
        )}
      </div>
    </ComposerStackedPanel>
  )
}
