import { create } from "zustand"

import type { PrPageKind, PrDetailResult, PrPageResult, ProjectId } from "@/protocol"
import { errorText, rpc } from "./rpc"
import { useStore } from "./store"

export interface ReviewState {
  detail: PrDetailResult | null
  page: PrPageResult | null
  kind: PrPageKind
  file: string | null
  loading: boolean
  error: string | null
  version: number
  draft: ReviewDraft
}
import { emptyReviewDraft, readReviewDraft, type ReviewDraft } from "./prReviewModel"
export { emptyReviewDraft } from "./prReviewModel"
const empty = (): ReviewState => ({ detail: null, page: null, kind: "files", file: null, loading: false, error: null, version: 0, draft: emptyReviewDraft() })
export const useReviews = create<{ entries: Record<string, ReviewState> }>(() => ({ entries: {} }))
export function reviewKey(projectId: ProjectId, number: number) {
  return `${useStore.getState().environmentId}:${projectId}:${number}`
}
function savedDraft(key: string): ReviewDraft {
  try {
    return readReviewDraft(JSON.parse(localStorage.getItem(`kybern.pr.draft:${key}`) ?? "null"))
  } catch { /* A corrupt local draft does not prevent reading the PR. */ }
  return emptyReviewDraft()
}
export function ensureReview(key: string) {
  if (useReviews.getState().entries[key]) return
  useReviews.setState((s) => ({ entries: { ...s.entries, [key]: { ...empty(), draft: savedDraft(key) } } }))
}
export function updateReview(key: string, patch: Partial<ReviewState>) {
  ensureReview(key)
  useReviews.setState((s) => ({ entries: { ...s.entries, [key]: { ...s.entries[key], ...patch } } }))
}
export function updateReviewDraft(key: string, patch: Partial<ReviewDraft>) {
  ensureReview(key)
  const draft = { ...useReviews.getState().entries[key].draft, ...patch }
  updateReview(key, { draft })
  try { localStorage.setItem(`kybern.pr.draft:${key}`, JSON.stringify(draft)) } catch { /* Keep in memory when storage is unavailable. */ }
}
export async function loadReview(projectId: ProjectId, number: number, kind?: PrPageKind, page = 1) {
  const key = reviewKey(projectId, number)
  ensureReview(key)
  const previous = useReviews.getState().entries[key]
  const version = previous.version + 1
  const selectedKind = kind ?? previous.kind
  updateReview(key, { loading: true, error: null, version, kind: selectedKind })
  try {
    const [detail, result] = await Promise.all([
      rpc().call("github.pr.detail", { project_id: projectId, number }),
      rpc().call("github.pr.page", { project_id: projectId, number, kind: selectedKind, page }),
    ])
    if (useReviews.getState().entries[key]?.version !== version) return
    updateReview(key, { detail, page: result, file: result.files.some((f) => f.path === previous.file) ? previous.file : result.files[0]?.path ?? null, loading: false })
    // Keep at most eight loaded PRs. Drafts remain durable and are never evicted.
    const loaded = Object.entries(useReviews.getState().entries).filter(([k, v]) => k !== key && v.detail)
    for (const [stale] of loaded.slice(0, Math.max(0, loaded.length - 7))) updateReview(stale, { detail: null, page: null })
  } catch (error) {
    if (useReviews.getState().entries[key]?.version === version) updateReview(key, { loading: false, error: `${errorText(error)} Refresh and try again.` })
  }
}
export function openPullRequest(projectId: ProjectId, number: number) {
  useStore.getState().selectPulls()
  useStore.getState().set({ prSelection: { projectId, number } })
}
