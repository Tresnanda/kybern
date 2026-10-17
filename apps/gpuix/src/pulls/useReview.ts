import { useCallback, useEffect, useRef, useState } from 'react'
import { afterReviewSubmission, assertReviewDraftHead, bindReviewDraft, readReviewDraft, repairReviewPrompt, type ReviewDraft } from '@/state/prReviewModel'
import type { PrActionKind, PrDetailResult, PrPageKind, PrPageResult } from '../../../../packages/kybern-client/src/types.ts'
import { load, save as persist } from './persist.ts'
import { getData } from '../composer/store.ts'
import { openThread } from '../nav/history.ts'
import { getClient, refreshLists, useApp } from '../state.ts'

export function useReview(projectId: string, number: number) {
  const key = `pulls.draft.${projectId}.${number}`
  const connection = useApp(s => s.status)
  const [detail, setDetail] = useState<PrDetailResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revision, refresh] = useState(0)
  const [draft, setDraft] = useState(() => readReviewDraft(load(key, null)))
  const draftRef = useRef(draft)
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const save = useCallback((next: ReviewDraft) => {
    draftRef.current = next
    // The shared shell store owns debouncing and environment scoping.
    persist(key, next)
    if (alive.current) setDraft(next)
  }, [key])
  const updateDraft = (patch: Partial<ReviewDraft>) => save(bindReviewDraft(draftRef.current, patch, detail?.head_sha ?? null))
  useEffect(() => {
    if (connection !== 'open') return
    let canceled = false
    setLoading(true)
    void getClient()!.call('github.pr.detail', { project_id: projectId, number }).then(next => {
      if (!canceled) { setDetail(next); setError(null); setLoading(false) }
    }, e => { if (!canceled) { setError(String(e)); setLoading(false) } })
    return () => { canceled = true }
  }, [projectId, number, revision, connection])
  const submit = async (action: PrActionKind, confirmedHead?: string, threadId?: string): Promise<boolean> => {
    if (!detail || submitting.current || !getClient()) return false
    const submitted = draftRef.current
    const review = ['comment', 'approve', 'request_changes'].includes(action)
    try {
      if (confirmedHead && confirmedHead !== detail.head_sha) throw new Error('The pull request changed while this confirmation was open. Cancel, review the current changes and open the action again.')
      if (review) assertReviewDraftHead(submitted, detail.head_sha)
      submitting.current = true; setBusy(true); setActionError(null)
      await getClient()!.call('github.pr.action', { project_id: projectId, number, action, head_sha: detail.head_sha, body: submitted.body, inline_comments: review ? submitted.inline : [], ...(threadId ? { thread_id: threadId } : {}) })
      if (review) save(afterReviewSubmission(draftRef.current, submitted))
      if (alive.current) refresh(n => n + 1)
      return true
    } catch (e) { if (alive.current) setActionError(String(e)); return false }
    finally { submitting.current = false; if (alive.current) setBusy(false) }
  }
  const repair = async (linkedId?: string): Promise<boolean> => {
    const settings = getData().settings
    const client = getClient()
    if (!detail || !settings || !client || submitting.current) return false
    try {
      assertReviewDraftHead(draftRef.current, detail.head_sha)
      const submitted = draftRef.current
      const prompt = repairReviewPrompt(number, detail.pull_request.title, detail.pull_request.url, detail.head_sha, submitted)
      submitting.current = true; setBusy(true); setActionError(null)
      let target = submitted.threadId === 'new' ? undefined : submitted.threadId ?? linkedId
      if (!target) {
        const created = await client.call('threads.create', {
          project_id: projectId,
          provider: { kind: settings.default_provider, instance: 'default' },
          permission_mode: settings.default_permission_mode,
          use_worktree: true,
        })
        target = created.id
        // Preserve the created identity before checkout: retry reuses it.
        save({ ...draftRef.current, threadId: target })
      }
      await client.call('github.pr.action', { project_id: projectId, number, action: 'checkout', thread_id: target, head_sha: detail.head_sha, for_repair: true })
      await client.call('threads.send', { thread_id: target, message: { parts: [{ type: 'text', text: prompt }] } })
      await refreshLists()
      openThread(target)
      return true
    } catch (e) { if (alive.current) setActionError(String(e)); return false }
    finally { submitting.current = false; if (alive.current) setBusy(false) }
  }
  return { detail, loading, error, refresh: () => refresh(n => n + 1), revision, draft, updateDraft, saveDraft: save, busy, actionError, submit, repair }
}

/** Page data is tagged by source and page so stale replies cannot replace a tab. */
export function usePage(projectId: string, number: number, kind: PrPageKind, page: number, revision: number, head: string | undefined, enabled = true) {
  const [state, setState] = useState<{ key: string; data?: PrPageResult; error?: string } | null>(null)
  const connection = useApp(s => s.status)
  const key = `${projectId}:${number}:${kind}:${page}:${revision}:${head}:${connection}`
  useEffect(() => {
    if (!enabled || !head || connection !== 'open') return
    let canceled = false
    void getClient()!.call('github.pr.page', { project_id: projectId, number, kind, page }).then(data => { if (!canceled) setState({ key, data }) }, e => { if (!canceled) setState({ key, error: String(e) }) })
    return () => { canceled = true }
  }, [key, projectId, number, kind, page, enabled, head, connection])
  return { data: state?.key === key ? state.data : undefined, error: state?.key === key ? state.error : undefined }
}
export type Review = ReturnType<typeof useReview>
