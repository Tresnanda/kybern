// Review actions for one pull request: publishing reviews, merge/close/checkout and
// sending findings to an agent. The logic is unchanged from the single-file view:
// head-SHA checks, durable drafts, and one repair thread per draft identity.

import { useState } from "react"

import type {
  PrActionKind,
  PrReviewEntry,
  ProjectId,
  ThreadId,
} from "@/protocol"
import {
  emptyReviewDraft,
  loadReview,
  updateReview,
  updateReviewDraft,
  useReviews,
} from "@/state/prReview"
import {
  assertReviewDraftHead,
  repairReviewPrompt,
  reviewDraftIsStale,
  selectedReviewFindings,
  submitReviewDraft,
  toggleReviewFinding,
} from "@/state/prReviewModel"
import { activeRuntime, errorText } from "@/state/rpc"
import { useStore } from "@/state/store"

export function usePrActions(
  key: string,
  projectId: ProjectId,
  number: number,
  threadId?: ThreadId
) {
  const environmentId = useStore((s) => s.environmentId)
  const review = useReviews((s) => s.entries[key])
  const threads = useStore((s) => s.threads)
  const settings = useStore((s) => s.settings)
  const busy = review?.submitting ?? false
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<PrActionKind | null>(null)
  const [confirmationHead, setConfirmationHead] = useState<string | null>(null)

  const detail = review?.detail
  const pr = detail?.pull_request
  const draft = review?.draft ?? emptyReviewDraft()
  const staleDraft = detail ? reviewDraftIsStale(draft, detail.head_sha) : false
  const linked =
    draft.threadId === "new"
      ? undefined
      : (draft.threadId ??
        threadId ??
        Object.values(threads).find(
          (t) =>
            t.project_id === projectId &&
            t.worktree?.branch === pr?.head &&
            t.status !== "archived" &&
            !t.subagent &&
            !t.delegation
        )?.id)
  const linkedThread = linked ? threads[linked] : null
  const choices = Object.values(threads).filter(
    (t) =>
      t.project_id === projectId &&
      t.worktree &&
      t.status !== "archived" &&
      !t.subagent &&
      !t.delegation
  )
  const selectedFindings = selectedReviewFindings(draft)
  const workspace = review?.workspace ?? "overview"

  const setBusy = (submitting: boolean) => updateReview(key, { submitting })
  const refresh = () =>
    loadReview(
      projectId,
      number,
      review?.kind,
      review?.page?.page ?? 1,
      workspace === "overview" && review?.kind !== "checks"
    )

  const openConfirmation = (action: PrActionKind) => {
    setConfirmationHead(detail?.head_sha ?? null)
    setActionError(null)
    setConfirmation(action)
  }

  /** Resolves true when GitHub accepted the action. */
  const submit = async (action: PrActionKind): Promise<boolean> => {
    if (!detail || useReviews.getState().entries[key]?.submitting) return false
    if (confirmation === action && confirmationHead !== detail.head_sha) {
      setActionError(
        "The pull request changed while this confirmation was open. Cancel, review the current changes and open the action again."
      )
      return false
    }
    const runtime = activeRuntime()
    const client = runtime.rpc()
    setBusy(true)
    setActionError(null)
    try {
      const isReview = ["comment", "approve", "request_changes"].includes(action)
      const publish = () =>
        client.call("github.pr.action", {
          project_id: projectId,
          number,
          action,
          head_sha: detail.head_sha,
          body: draft.body,
          inline_comments: isReview ? draft.inline : [],
          ...(linked ? { thread_id: linked } : {}),
        })
      if (isReview) {
        await submitReviewDraft(
          draft,
          publish,
          () => useReviews.getState().entries[key].draft,
          (next) => updateReviewDraft(key, next),
          detail.head_sha
        )
      } else await publish()
      setConfirmation(null)
      await refresh()
      if (linked) void runtime.loadGitStatus(linked)
      return true
    } catch (error) {
      setActionError(errorText(error))
      return false
    } finally {
      setBusy(false)
    }
  }

  const repair = async (): Promise<boolean> => {
    if (!detail || !settings || useReviews.getState().entries[key]?.submitting)
      return false
    const runtime = activeRuntime()
    const client = runtime.rpc()
    setBusy(true)
    setActionError(null)
    try {
      assertReviewDraftHead(draft, detail.head_sha)
      const body = repairReviewPrompt(
        number,
        detail.pull_request.title,
        detail.pull_request.url,
        detail.head_sha,
        draft
      )
      let target = linked
      if (!target) {
        target = await runtime.createThread({
          projectId,
          provider: { kind: settings.default_provider, instance: "default" },
          permissionMode: settings.default_permission_mode,
          useWorktree: true,
        })
        // Keep this identity even when checkout/send fails, so retry never creates
        // a second repair conversation or loses the selected findings.
        updateReviewDraft(key, { threadId: target })
      }
      // Branch names can collide across fork PRs, and a local branch can be stale.
      // The daemon proves this checkout belongs to the reviewed head before send.
      await client.call("github.pr.action", {
        project_id: projectId,
        number,
        action: "checkout",
        thread_id: target,
        head_sha: detail.head_sha,
        for_repair: true,
      })
      await runtime.sendMessage(target, {
        parts: [{ type: "text", text: body }],
      })
      setConfirmation(null)
      if (useStore.getState().environmentId !== environmentId) return true
      useStore.getState().selectThread(target)
      useStore.getState().set({ rightOpen: true, rightTab: "review" })
      return true
    } catch (error) {
      setActionError(errorText(error))
      return false
    } finally {
      setBusy(false)
    }
  }

  const toggleFinding = (entry: PrReviewEntry) => {
    const next = toggleReviewFinding(draft, `${review?.kind}:${entry.id}`, entry)
    if (next === draft)
      setActionError("Select at most 100 findings for one repair.")
    else updateReviewDraft(key, next)
  }

  const clearSelection = () => updateReviewDraft(key, { selected: [], findings: {} })

  return {
    clearSelection,
    review,
    detail,
    pr,
    draft,
    staleDraft,
    linked,
    linkedThread,
    choices,
    selectedFindings,
    settings,
    busy,
    actionError,
    setActionError,
    confirmation,
    setConfirmation,
    openConfirmation,
    submit,
    repair,
    refresh,
    toggleFinding,
  }
}

export type PrActions = ReturnType<typeof usePrActions>
