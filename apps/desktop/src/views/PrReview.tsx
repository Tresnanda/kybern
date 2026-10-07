import { useEffect, useRef, useState } from "react"

import { FileDiffBody, FileDiffHeader } from "@/components/kybern/DiffView"
import { Markdown } from "@/components/kybern/Markdown"
import { Button } from "@/components/kit/button"
import { Checkbox } from "@/components/kit/checkbox"
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "@/components/kit/dialog"
import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { Menu, MenuGroup, MenuItem, MenuTrigger } from "@/components/kit/menu"
import { Textarea } from "@/components/kit/textarea"
import { parseUnifiedDiff, type FileDiff } from "@/lib/diff"
import { ArrowLeftIcon, ArrowUpRightIcon, GitPullRequestIcon, RefreshCwIcon } from "@/lib/kit/icons"
import { openExternal } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import type { PrActionKind, PrFile, PrPageKind, PrReviewEntry, ProjectId, ThreadId } from "@/protocol"
import { emptyReviewDraft, ensureReview, loadReview, reviewKey, updateReview, updateReviewDraft, useReviews } from "@/state/prReview"
import { repairReviewPrompt, selectedReviewFindings, submitReviewDraft, toggleReviewFinding } from "@/state/prReviewModel"
import { activeRuntime, errorText, loadGitStatus } from "@/state/rpc"
import { useStore } from "@/state/store"
import { SurfaceHeader } from "./chrome"
import { CHAT_COLUMN_GUTTER } from "./chatLayout"

const TABS: [PrPageKind, string][] = [["files", "Files"], ["comments", "Comments"], ["review_comments", "Inline comments"], ["reviews", "Reviews"], ["checks", "Checks"]]
const LABELS: Record<PrActionKind, string> = { comment: "Post comment", approve: "Approve", request_changes: "Request changes", checkout: "Check out pull request", merge: "Merge pull request", close: "Close pull request" }
const ROW = "rounded-lg px-2.5 py-2 text-start font-system-ui text-[length:var(--app-font-size-ui,12px)] hover:bg-[var(--color-background-elevated-secondary)] focus-visible:outline focus-visible:outline-ring"

function prFileDiff(file: PrFile): FileDiff {
  const patch = `diff --git a/${file.old_path ?? file.path} b/${file.path}\n--- a/${file.old_path ?? file.path}\n+++ b/${file.path}\n${file.patch}`
  const parsed = parseUnifiedDiff(patch)[0]
  return { path: file.path, oldPath: file.old_path, status: file.status === "added" ? "added" : file.status === "removed" ? "deleted" : "modified", binary: !file.patch, hunks: parsed?.hunks ?? [], additions: file.additions, deletions: file.deletions }
}

export function PrReview({ projectId, number, threadId, dock = false, active = true, onBack }: {
  projectId: ProjectId; number: number; threadId?: ThreadId; dock?: boolean; active?: boolean; onBack?: () => void
}) {
  const environmentId = useStore((s) => s.environmentId)
  const key = `${environmentId}:${projectId}:${number}`
  const review = useReviews((s) => s.entries[key])
  const threads = useStore((s) => s.threads)
  const settings = useStore((s) => s.settings)
  const project = useStore((s) => s.projects[projectId])
  const busy = review?.submitting ?? false
  const setBusy = (submitting: boolean) => updateReview(key, { submitting })
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<PrActionKind | null>(null)
  const anchor = review?.draft.pendingInline
  const inlineBody = anchor?.body ?? ""
  const inlineInput = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!active) return
    ensureReview(key)
    const current = useReviews.getState().entries[key]
    if (!current.detail && !current.loading) void loadReview(projectId, number)
  }, [active, key, number, projectId])
  const anchorPath = anchor?.path
  const anchorLine = anchor?.line
  const anchorSide = anchor?.side
  useEffect(() => { if (anchorPath) inlineInput.current?.focus() }, [anchorPath, anchorLine, anchorSide])
  if (!active) return null
  const detail = review?.detail
  const pr = detail?.pull_request
  const draft = review?.draft ?? emptyReviewDraft()
  const linked = draft.threadId === "new" ? undefined : draft.threadId ?? threadId ?? Object.values(threads).find((t) => t.project_id === projectId && t.worktree?.branch === pr?.head && t.status !== "archived" && !t.subagent && !t.delegation)?.id
  const linkedThread = linked ? threads[linked] : null
  const choices = Object.values(threads).filter((t) => t.project_id === projectId && t.worktree && t.status !== "archived" && !t.subagent && !t.delegation)
  const file = review?.page?.files.find((f) => f.path === review.file)
  const selectedFindings = selectedReviewFindings(draft)

  const submit = async (action: PrActionKind) => {
    if (!detail || useReviews.getState().entries[key]?.submitting) return
    const runtime = activeRuntime()
    const client = runtime.rpc()
    setBusy(true); setActionError(null)
    try {
      const publish = () => client.call("github.pr.action", { project_id: projectId, number, action, head_sha: detail.head_sha, body: draft.body, inline_comments: ["comment", "approve", "request_changes"].includes(action) ? draft.inline : [], ...(linked ? { thread_id: linked } : {}) })
      if (["comment", "approve", "request_changes"].includes(action)) {
        await submitReviewDraft(draft, publish, () => useReviews.getState().entries[key].draft, (next) => updateReviewDraft(key, next))
      } else await publish()
      setConfirmation(null)
      await loadReview(projectId, number, review?.kind, review?.page?.page ?? 1)
      if (linked) void runtime.loadGitStatus(linked)
    } catch (error) { setActionError(errorText(error)) } finally { setBusy(false) }
  }
  const repair = async () => {
    if (!detail || !settings || useReviews.getState().entries[key]?.submitting) return
    const runtime = activeRuntime()
    const client = runtime.rpc()
    setBusy(true); setActionError(null)
    try {
      const body = repairReviewPrompt(number, detail.pull_request.title, detail.pull_request.url, detail.head_sha, draft)
      let target = linked
      if (!target) {
        target = await runtime.createThread({ projectId, provider: { kind: settings.default_provider, instance: "default" }, permissionMode: settings.default_permission_mode, useWorktree: true })
        // Keep this identity even when checkout/send fails, so retry never creates
        // a second repair conversation or loses the selected findings.
        updateReviewDraft(key, { threadId: target })
      }
      const status = await client.call("git.status", { thread_id: target })
      if (status.branch !== detail.pull_request.head) {
        await client.call("github.pr.action", { project_id: projectId, number, action: "checkout", thread_id: target })
      }
      await runtime.sendMessage(target, { parts: [{ type: "text", text: body }] })
      setConfirmation(null)
      if (useStore.getState().environmentId !== environmentId) return
      useStore.getState().selectThread(target)
      useStore.getState().set({ rightOpen: true, rightTab: "review" })
    } catch (error) { setActionError(errorText(error)) } finally { setBusy(false) }
  }
  const toggleFinding = (entry: PrReviewEntry) => {
    const next = toggleReviewFinding(draft, `${review?.kind}:${entry.id}`, entry)
    if (next === draft) setActionError("Select at most 100 findings for one repair.")
    else updateReviewDraft(key, next)
  }

  return <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--color-background-surface)] font-system-ui text-[length:var(--app-font-size-ui,12px)] text-foreground">
    {!dock && <SurfaceHeader trailing={<Button size="icon-sm" variant="ghost" aria-label="Refresh pull request" disabled={review?.loading} onClick={() => void loadReview(projectId, number, review?.kind, review?.page?.page ?? 1)}><RefreshCwIcon className="size-4" /></Button>}>
      <Button size="icon-sm" variant="ghost" aria-label="Back to pull requests" onClick={onBack}><ArrowLeftIcon className="size-4" /></Button>
      <GitPullRequestIcon className="size-4 shrink-0" /><h1 className="truncate text-sm font-medium">{project?.name} · #{number}</h1>
    </SurfaceHeader>}
    <div className="min-h-0 flex-1 overflow-auto">
      <div className={cn("mx-auto flex w-full max-w-5xl flex-col gap-6 py-5", dock ? "px-3" : CHAT_COLUMN_GUTTER)}>
        {(review?.error || actionError) && <p role="alert" className="break-words rounded-lg border border-destructive/20 bg-destructive/5 p-3 leading-relaxed text-destructive">{actionError ?? review?.error} {actionError && "Your draft is kept. Check the pull request and try again."}</p>}
        {!detail ? <div role="status" className="py-8 text-muted-foreground">{review?.loading ? "Loading pull request…" : "Refresh to read this pull request."}<Button variant="ghost" onClick={() => void loadReview(projectId, number)}>Refresh</Button></div> : <>
          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2 text-muted-foreground"><span className="rounded-md bg-[var(--color-background-elevated-secondary)] px-2 py-1">{pr?.state.toLowerCase()}{pr?.is_draft ? " · draft" : ""}</span><span>#{number} by {pr?.author}</span><span className="break-all">{pr?.head} → {pr?.base}</span></div>
            <h2 className="break-words text-lg leading-snug font-medium [text-wrap:balance]">{pr?.title}</h2>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => void openExternal(pr!.url)}>Open on GitHub <ArrowUpRightIcon className="size-3.5" /></Button>
              <Menu><MenuTrigger render={<Button variant="secondary" size="sm" />}>Review actions</MenuTrigger><ComposerPickerMenuPopup align="start"><MenuGroup>
                <MenuItem disabled={busy || !linked || linkedThread?.status === "running" || linkedThread?.status === "awaiting-approval"} onClick={() => setConfirmation("checkout")}>Check out pull request</MenuItem>
                <MenuItem disabled={busy || pr?.state !== "OPEN" || pr.is_draft} onClick={() => setConfirmation("merge")}>Merge pull request</MenuItem>
                <MenuItem disabled={busy || pr?.state !== "OPEN"} onClick={() => setConfirmation("close")}>Close pull request</MenuItem>
              </MenuGroup></ComposerPickerMenuPopup></Menu>
              {dock && <Button variant="ghost" size="sm" onClick={() => { useStore.getState().selectPulls(); useStore.getState().set({ prSelection: { projectId, number } }) }}>Open full review</Button>}
            </div>
            <details><summary className="cursor-pointer py-1 font-medium">Description</summary><div className="max-w-[75ch] break-words pt-2 leading-relaxed">{detail.body ? <Markdown text={detail.body} /> : <p className="text-muted-foreground">No description.</p>}</div></details>
            <details><summary className="cursor-pointer py-1 font-medium">Checks and reviewers</summary><div className="flex flex-col gap-2 pt-2">
              <p className="break-words text-muted-foreground">Requested reviewers: {detail.reviewers.join(", ") || "None"}</p>
              {detail.checks.map((check, i) => <div key={`${check.name}:${i}`} className="flex flex-wrap items-center justify-between gap-2"><span className="break-words">{check.name}</span><Button variant="ghost" size="sm" disabled={!check.url} onClick={() => void openExternal(check.url)}>{check.conclusion || check.status || "Pending"}</Button></div>)}
              {!detail.checks.length && <p className="text-muted-foreground">No checks reported.</p>}
              <Button variant="ghost" size="sm" className="self-start" onClick={() => void loadReview(projectId, number, "checks")}>View all check pages</Button>
            </div></details>
          </section>
          <section className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap gap-1" role="tablist" aria-label="Review content" onKeyDown={(event) => {
              const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
              const index = buttons.indexOf(event.target as HTMLButtonElement)
              if (index < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
              event.preventDefault()
              const rtl = getComputedStyle(event.currentTarget).direction === "rtl"
              const step = event.key === "ArrowRight" ? (rtl ? -1 : 1) : (rtl ? 1 : -1)
              const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + step + buttons.length) % buttons.length
              buttons[next]?.focus(); buttons[next]?.click()
            }}>{TABS.map(([kind, label]) => <Button key={kind} id={`pr-tab-${dock ? "dock" : "page"}-${key}-${kind}`} role="tab" tabIndex={review?.kind === kind ? 0 : -1} aria-controls={`pr-panel-${dock ? "dock" : "page"}-${key}`} aria-selected={review?.kind === kind} variant={review?.kind === kind ? "secondary" : "ghost"} size="sm" onClick={() => { void loadReview(projectId, number, kind) }}>{label}{kind === "files" ? ` (${detail.changed_files})` : ""}</Button>)}</div>
            <div role="tabpanel" id={`pr-panel-${dock ? "dock" : "page"}-${key}`} aria-labelledby={`pr-tab-${dock ? "dock" : "page"}-${key}-${review?.kind ?? "files"}`} className="flex min-w-0 flex-col gap-3"><div role="status" className="text-muted-foreground">{review?.loading ? "Refreshing…" : `Page ${review?.page?.page ?? 1}`}</div>
            {review?.kind === "files" ? <>
              <div className="max-h-52 overflow-auto rounded-lg border border-[color:var(--color-border)]" aria-label="Changed files">{review.page?.files.map((f) => <button key={f.path} type="button" aria-pressed={file?.path === f.path} className={cn(ROW, "flex w-full items-start justify-between gap-2", file?.path === f.path && "bg-[var(--color-background-button-secondary)]")} onClick={() => { updateReview(key, { file: f.path }) }}><span className="min-w-0 break-all">{f.path}</span><span className="shrink-0 tabular-nums">+{f.additions} −{f.deletions}</span></button>)}</div>
              {file && <div key={file.path} className="min-w-0 overflow-hidden rounded-lg border border-[color:var(--color-border)]"><FileDiffHeader file={prFileDiff(file)} /><FileDiffBody file={prFileDiff(file)} onLineSelect={(line, side) => { updateReviewDraft(key, { pendingInline: { path: file.path, line, side, body: "" } }) }} />{file.patch_truncated && <p className="p-3 text-muted-foreground">GitHub omitted or truncated this patch. Open the pull request on GitHub to read the full file.</p>}</div>}
              {!review.page?.files.length && <p className="text-muted-foreground">No changed files on this page.</p>}
              {anchor && <div className="flex flex-col gap-2"><label htmlFor={`inline-${number}`} className="break-all font-medium">Comment on {anchor.path}:{anchor.line} · {anchor.side === "LEFT" ? "original" : "new"} version</label><Textarea ref={inlineInput} id={`inline-${number}`} value={inlineBody} maxLength={65536} onChange={(e) => anchor && updateReviewDraft(key, { pendingInline: { ...anchor, body: e.target.value } })} className="[&_textarea]:min-h-24 [&_textarea]:leading-relaxed" /><div className="flex gap-2"><Button size="sm" disabled={!inlineBody.trim() || draft.inline.length >= 100} onClick={() => { updateReviewDraft(key, { inline: [...draft.inline, { ...anchor, body: inlineBody }], pendingInline: null }) }}>Save inline draft</Button><Button size="sm" variant="ghost" onClick={() => updateReviewDraft(key, { pendingInline: null })}>Cancel</Button></div></div>}
            </> : review?.kind === "checks" ? <div className="flex flex-col gap-2">{review.page?.checks?.map((check, index) => <div key={`${check.name}:${index}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[color:var(--color-border)] p-3"><span className="break-words">{check.name}</span><Button variant="ghost" size="sm" disabled={!check.url} onClick={() => void openExternal(check.url)}>{check.conclusion || check.status || "Pending"}</Button></div>)}{!review.page?.checks?.length && <p className="text-muted-foreground">No checks on this page.</p>}</div> : <div className="flex flex-col gap-4">{review?.page?.entries.map((entry) => <article key={entry.id} className="flex flex-col gap-2 rounded-lg border border-[color:var(--color-border)] p-3"><div className="flex flex-wrap items-center gap-2"><label className="flex items-center gap-2"><Checkbox aria-label={`Select finding by ${entry.author}`} checked={draft.selected.includes(`${review.kind}:${entry.id}`)} onCheckedChange={() => toggleFinding(entry)} /><span className="font-medium">{entry.author}</span></label><span className="text-muted-foreground">{entry.state.toLowerCase().replaceAll("_", " ")}</span></div>{entry.path && <p className="break-all text-muted-foreground">{entry.path}:{entry.line ?? "outdated"}</p>}<div className="break-words leading-relaxed"><Markdown text={entry.body || "No review summary."} /></div></article>)}{!review?.page?.entries.length && <p className="text-muted-foreground">No {TABS.find(([kind]) => kind === review?.kind)?.[1].toLowerCase()} on this page.</p>}</div>}
            <div className="flex flex-wrap gap-2"><Button variant="secondary" size="sm" disabled={review?.loading || (review?.page?.page ?? 1) <= 1} onClick={() => void loadReview(projectId, number, review?.kind, (review?.page?.page ?? 1) - 1)}>Previous page</Button><Button variant="secondary" size="sm" disabled={review?.loading || !review?.page?.has_more} onClick={() => void loadReview(projectId, number, review?.kind, (review?.page?.page ?? 1) + 1)}>Next page</Button></div></div>
          </section>
          <section className="flex flex-col gap-3">
            <h3 className="font-medium">Your review</h3>
            {draft.inline.map((comment, i) => <div key={`${comment.path}:${comment.side}:${comment.line}:${i}`} className="flex items-start gap-2 rounded-lg border border-[color:var(--color-border)] p-3"><div className="min-w-0 flex-1"><p className="break-all font-medium">{comment.path}:{comment.line} · {comment.side === "LEFT" ? "original" : "new"}</p><p className="break-words whitespace-pre-wrap">{comment.body}</p></div><Button variant="ghost" size="sm" onClick={() => updateReviewDraft(key, { inline: draft.inline.filter((_, index) => index !== i) })}>Remove draft</Button></div>)}
            <label htmlFor={`review-${dock ? "dock" : "page"}-${number}`}>Review summary or comment</label><Textarea id={`review-${dock ? "dock" : "page"}-${number}`} value={draft.body} maxLength={65536} onChange={(e) => updateReviewDraft(key, { body: e.target.value })} />
            <p className="text-muted-foreground">Drafts stay here until GitHub accepts your submission. Select a line number to add an inline draft.</p>
            <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy || (!draft.body.trim() && !draft.inline.length)} onClick={() => void submit("comment")}>Post comment{draft.inline.length ? ` and ${draft.inline.length} inline drafts` : ""}</Button><Button size="sm" variant="secondary" disabled={busy || pr?.state !== "OPEN"} onClick={() => setConfirmation("approve")}>Approve</Button><Button size="sm" variant="secondary" disabled={busy || pr?.state !== "OPEN" || (!draft.body.trim() && !draft.inline.length)} onClick={() => setConfirmation("request_changes")}>Request changes</Button></div>
          </section>
          <section className="flex flex-col gap-3">
            <h3 className="font-medium">Repair with an agent</h3>
            <Menu><MenuTrigger render={<Button variant="secondary" size="sm" className="max-w-full self-start" />}>{linkedThread?.title ?? "Create a repair conversation"}</MenuTrigger><ComposerPickerMenuPopup align="start" className="max-w-80"><MenuGroup><MenuItem onClick={() => updateReviewDraft(key, { threadId: "new" })}>Create a repair conversation</MenuItem>{choices.map((t) => <MenuItem key={t.id} onClick={() => updateReviewDraft(key, { threadId: t.id })}><span className="truncate">{t.title}</span></MenuItem>)}</MenuGroup></ComposerPickerMenuPopup></Menu>
            <p className="leading-relaxed text-muted-foreground">Send {selectedFindings.length + draft.inline.length} selected findings and inline drafts. The agent repairs the branch; you review and merge separately.</p>
            <Button className="self-start" size="sm" disabled={busy || !settings || (!selectedFindings.length && !draft.inline.length) || linkedThread?.status === "running" || linkedThread?.status === "awaiting-approval"} onClick={() => void repair()}>{busy ? "Sending…" : "Send to agent"}</Button>
          </section>
        </>}
      </div>
    </div>
    <Dialog open={confirmation !== null} onOpenChange={(open) => { if (!open && !busy) setConfirmation(null) }}><DialogPopup><DialogHeader><DialogTitle>{`${confirmation ? LABELS[confirmation] : "Review"}?`}</DialogTitle><DialogDescription>{confirmation === "merge" ? `Squash merge #${number} at the reviewed head into ${pr?.base}. The branch stays available.` : confirmation === "close" ? `Close #${number} on GitHub. Its branch and your drafts remain available.` : confirmation === "checkout" ? `Check out #${number} in ${linkedThread?.title ?? "the linked conversation"}. Running work, dirty files and open terminals block checkout.` : "Publish your review summary and saved inline drafts on GitHub."}</DialogDescription></DialogHeader>{actionError && <p role="alert" className="px-4 py-2 text-destructive">{actionError} Your draft is kept.</p>}<DialogFooter><Button variant="ghost" disabled={busy} onClick={() => setConfirmation(null)}>Cancel</Button><Button disabled={busy} onClick={() => confirmation && void submit(confirmation)}>{busy ? "Working…" : confirmation ? LABELS[confirmation] : "Submit"}</Button></DialogFooter></DialogPopup></Dialog>
  </div>
}

export function PrReviewDock({ threadId, active }: { threadId: ThreadId; active: boolean }) {
  const thread = useStore((s) => s.threads[threadId])
  const git = useStore((s) => s.gitStatuses[threadId])
  useEffect(() => { if (active) void loadGitStatus(threadId) }, [active, threadId])
  if (!active) return null
  if (!thread || !git?.pull_request) return <div className="flex flex-1 flex-col items-center justify-center gap-3 p-5 text-center text-xs text-muted-foreground"><p>No pull request is linked to this branch.</p><Button variant="secondary" size="sm" onClick={() => void loadGitStatus(threadId)}>Refresh branch</Button><Button variant="ghost" size="sm" onClick={() => useStore.getState().selectPulls()}>Open pull requests</Button></div>
  return <PrReview key={reviewKey(thread.project_id, git.pull_request.number)} projectId={thread.project_id} number={git.pull_request.number} threadId={threadId} dock active={active} />
}
