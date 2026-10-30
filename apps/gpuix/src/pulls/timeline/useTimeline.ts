import { useCallback, useEffect, useRef, useState } from 'react'
import type { PrTimelineEvent } from '../../../../../packages/kybern-client/src/types.ts'
import { useApp } from '../../state.ts'
import { prClient } from '../client.ts'
import { mergeTimeline, TIMELINE_LIMIT } from './model.ts'

interface State { key: string; events: PrTimelineEvent[]; cursor?: string; page: number; hasMore: boolean; loading: boolean; error?: string }

/**
 * The pull request's history, oldest first, one cursor page (30) at a time. A new key (another pull request, a refresh
 * or a new head) starts again; a reply for an older key is dropped. At most `TIMELINE_LIMIT` events are kept.
 */
export function useTimeline(projectId: string, number: number, repo: string | undefined, revision: number, head: string | undefined) {
  const connection = useApp(s => s.status)
  const key = `${projectId}${repo ? `/${repo}` : ''}:${number}:${revision}:${head}:${connection}`
  const [state, setState] = useState<State>({ key, events: [], page: 0, hasMore: false, loading: true })
  const current = useRef(state)
  current.current = state
  const fetchPage = useCallback((forKey: string, cursor: string | undefined, page: number) => {
    const client = prClient(projectId)
    if (!client) return
    void client.call('github.pr.page', { project_id: projectId, number, kind: 'timeline', page, ...(cursor ? { cursor } : {}), ...(repo ? { repo } : {}) }).then(result => {
      setState(s => s.key !== forKey ? s : { key: forKey, events: mergeTimeline(page === 1 ? [] : s.events, result.timeline ?? []), ...(result.next_cursor ? { cursor: result.next_cursor } : {}), page, hasMore: !!result.has_more && !!result.next_cursor, loading: false })
    }, e => { setState(s => s.key !== forKey ? s : { ...s, loading: false, error: String(e) }) })
  }, [projectId, number, repo])
  useEffect(() => {
    if (!head || connection !== 'open') return
    setState({ key, events: [], page: 0, hasMore: false, loading: true })
    fetchPage(key, undefined, 1)
  }, [key, head, connection, fetchPage])
  const more = useCallback(() => {
    const s = current.current
    if (s.key !== key || s.loading || !s.hasMore || !s.cursor || s.events.length >= TIMELINE_LIMIT) return
    setState({ ...s, loading: true })
    fetchPage(key, s.cursor, s.page + 1)
  }, [key, fetchPage])
  const fresh = state.key === key
  return { events: fresh ? state.events : [], hasMore: fresh && state.hasMore, loading: !fresh || state.loading, error: fresh ? state.error : undefined, more, full: fresh && state.events.length >= TIMELINE_LIMIT }
}
