import { useEffect, useState } from "react"

import { Alert } from "@/components/kit/alert"
import { Button } from "@/components/kit/button"
import {
  loadReview,
  ensureReview,
  reviewKey,
  updateReview,
  useReviews,
} from "@/state/prReview"
import { classifyPrError, reviewWorkspaceKind, type ReviewWorkspace } from "@/state/prReviewModel"
import { loadGitStatus } from "@/state/rpc"
import { useStore } from "@/state/store"
import type { ProjectId, ThreadId } from "@/protocol"

import { PrChangesTab } from "./pullRequests/PrChangesTab"
import { PrConfirmDialog } from "./pullRequests/PrMergeButton"
import { DetailSkeleton, GhProblem } from "./pullRequests/PrStates"
import { PrSummaryTab } from "./pullRequests/PrSummaryTab"
import { PrTimelineTab } from "./pullRequests/PrTimelineTab"
import { PrTopBar } from "./pullRequests/PrTopBar"
import { usePrActions } from "./pullRequests/usePrActions"
import "./pullRequests/review.css"

export function PrReview({
  projectId,
  number,
  threadId,
  dock = false,
  active = true,
  onBack,
}: {
  projectId: ProjectId
  number: number
  threadId?: ThreadId
  dock?: boolean
  active?: boolean
  onBack?: () => void
}) {
  const environmentId = useStore((s) => s.environmentId)
  const key = `${environmentId}:${projectId}:${number}`
  const project = useStore((s) => s.projects[projectId])
  const actions = usePrActions(key, projectId, number, threadId)
  const { review, detail, busy, linked, linkedThread, actionError, confirmation } = actions
  const [sendOpen, setSendOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)

  useEffect(() => {
    if (!active) return
    ensureReview(key)
    const current = useReviews.getState().entries[key]
    if (!current.detail && !current.loading)
      void loadReview(
        projectId,
        number,
        undefined,
        1,
        current.workspace === "overview" && current.kind !== "checks"
      )
  }, [active, key, number, projectId])

  // Mergeability is computed lazily by GitHub: read it once more shortly after.
  const mergeUnknown =
    detail?.pull_request.state === "OPEN" &&
    (!detail.merge_state_status || detail.merge_state_status === "UNKNOWN")
  const [rechecked, setRechecked] = useState(false)
  useEffect(() => {
    if (!active || !mergeUnknown || rechecked) return
    const id = window.setTimeout(() => {
      setRechecked(true)
      void loadReview(projectId, number, undefined, 1, true)
    }, 4000)
    return () => window.clearTimeout(id)
  }, [active, mergeUnknown, rechecked, projectId, number])

  if (!active) return null
  const workspace = review?.workspace ?? "overview"
  const mode = dock ? "dock" : "page"
  const panelId = `pr-workspace-${mode}-${key}`
  const selectWorkspace = (next: ReviewWorkspace) => {
    updateReview(key, { workspace: next })
    if (next !== "overview") {
      const kind = reviewWorkspaceKind(next, review?.kind ?? "files")
      if (review?.kind !== kind || !review.page)
        void loadReview(projectId, number, kind)
    }
  }
  const error = review?.error
  const errorClass = error ? classifyPrError(error) : null
  const ghProblem =
    errorClass === "gh-missing" || errorClass === "gh-auth" ? errorClass : null
  const showActionError = !!actionError && !reviewOpen && !sendOpen && !confirmation
  const kind = review?.kind ?? "files"

  return (
    <div
      className="pr-review font-system-ui flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--color-background-surface)] text-[length:var(--app-font-size-ui,12px)] text-foreground"
      data-workspace={workspace}
      data-review-mode={mode}
    >
      <PrTopBar
        actions={actions}
        stateKey={key}
        number={number}
        dock={dock}
        workspace={workspace}
        onWorkspace={selectWorkspace}
        panelId={panelId}
        detail={detail}
        loading={!!review?.loading}
        onBack={onBack}
        onOpenFull={() => {
          useStore.getState().selectPulls()
          useStore.getState().set({ prSelection: { projectId, number } })
        }}
        sendOpen={sendOpen}
        onSendOpen={setSendOpen}
        reviewOpen={reviewOpen}
        onReviewOpen={setReviewOpen}
      />
      <div className="pr-review-scroll" data-pr-scroll>
        {(showActionError || (error && detail)) && !ghProblem && (
          <div className="mx-6 mt-4">
            <Alert variant="error" size="sm" className="items-center">
              <div className="min-w-0 break-words">
                {actionError ?? error}{" "}
                {actionError && "Your draft is kept. Check the pull request and try again."}
              </div>
              <Button size="xs" variant="ghost" onClick={() => void actions.refresh()}>
                Try again
              </Button>
            </Alert>
          </div>
        )}
        {!detail ? (
          ghProblem ? (
            <GhProblem kind={ghProblem} onRefresh={() => void actions.refresh()} />
          ) : error ? (
            <div className="mx-6 mt-4">
              <Alert variant="error" size="sm" className="items-center">
                <div role="status" className="min-w-0 break-words">{error}</div>
                <Button size="xs" variant="ghost" onClick={() => void actions.refresh()}>
                  Try again
                </Button>
              </Alert>
            </div>
          ) : (
            <DetailSkeleton />
          )
        ) : (
          <div
            role="tabpanel"
            id={`${panelId}-panel`}
            aria-labelledby={`${panelId}-${workspace}`}
          >
            {workspace === "overview" ? (
              <PrSummaryTab
                detail={detail}
                projectName={project?.name}
                number={number}
                dock={dock}
                pagedChecks={kind === "checks" ? (review?.page ?? null) : null}
                checksKind={kind === "checks"}
                loading={!!review?.loading}
                onLoadChecks={() => void loadReview(projectId, number, "checks")}
                onChecksPage={(page) => void loadReview(projectId, number, "checks", page)}
                onOpenTimeline={() => selectWorkspace("conversation")}
                linkedTitle={linkedThread?.title}
                onOpenConversation={
                  linked ? () => useStore.getState().selectThread(linked) : undefined
                }
              />
            ) : workspace === "changes" ? (
              kind === "files" ? (
                <PrChangesTab
                  actions={actions}
                  stateKey={key}
                  projectId={projectId}
                  number={number}
                  mode={mode}
                />
              ) : (
                <p role="status" className="p-6 text-muted-foreground">Loading changes…</p>
              )
            ) : kind === "files" || kind === "checks" ? (
              <p role="status" className="p-6 text-muted-foreground">Loading timeline…</p>
            ) : (
              <PrTimelineTab
                actions={actions}
                projectId={projectId}
                number={number}
                panelId={panelId}
                onSend={() => setSendOpen(true)}
              />
            )}
          </div>
        )}
      </div>
      <PrConfirmDialog actions={actions} number={number} />
      {busy && <span className="sr-only" role="status">Working…</span>}
    </div>
  )
}

export function PrReviewDock({
  threadId,
  active,
}: {
  threadId: ThreadId
  active: boolean
}) {
  const thread = useStore((s) => s.threads[threadId])
  const git = useStore((s) => s.gitStatuses[threadId])
  useEffect(() => {
    if (active) void loadGitStatus(threadId)
  }, [active, threadId])
  if (!active) return null
  if (!thread || !git?.pull_request)
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-5 text-center text-xs text-muted-foreground">
        <p>No pull request is linked to this branch.</p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void loadGitStatus(threadId)}
        >
          Refresh branch
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => useStore.getState().selectPulls()}
        >
          Open pull requests
        </Button>
      </div>
    )
  return (
    <PrReview
      key={reviewKey(thread.project_id, git.pull_request.number)}
      projectId={thread.project_id}
      number={git.pull_request.number}
      threadId={threadId}
      dock
      active={active}
    />
  )
}
