import { useCallback, useEffect, useRef, useState } from 'react'
import { asError } from '../../../../../packages/kybern-client/src/problem.ts'
import type { IssueDetailResult } from '../../../../../packages/kybern-client/src/types.ts'
import { useMachines } from '../../machines/index.ts'
import { useApp } from '../../state.ts'
import { prCall, prClient } from '../client.ts'

const details = new Map<string, IssueDetailResult>()

/** One issue with its comments (`github.issue.detail`), read again on `refresh()` and when its machine reconnects. `repo`: the member repository of a group project.
 *  `update` changes the held copy (a comment posted from the page). */
export function useIssue(projectId: string, number: number, repo?: string) {
  const connection = useApp(s => s.status)
  useMachines() // A remote project's reconnect retries its open issue.
  const client = prClient(projectId)
  const key = `${projectId}/${repo ?? ''}:${number}`
  const [detail, setDetail] = useState<IssueDetailResult | null>(() => details.get(key) ?? null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [revision, refresh] = useState(0)
  useEffect(() => {
    if (connection !== 'open') return
    let canceled = false
    setLoading(true)
    void prCall(projectId, 'github.issue.detail', { project_id: projectId, number, ...(repo ? { repo } : {}) }).then(next => {
      if (canceled) return
      const known = details.get(key)
      const value = known && JSON.stringify(known) === JSON.stringify(next) ? known : next
      details.delete(key); details.set(key, value)
      while (details.size > 8) details.delete(details.keys().next().value!)
      setDetail(value); setError(null); setLoading(false)
    }, e => { if (!canceled) { setError(asError(e)); setLoading(false) } })
    return () => { canceled = true }
  }, [projectId, number, repo, revision, connection, client, key])
  const current = useRef(key)
  current.current = key
  /** Change the held issue (a comment posted from here): kept for the next visit, and shown if it is still the one open. */
  const update = useCallback((change: (detail: IssueDetailResult) => IssueDetailResult) => {
    const known = details.get(key)
    if (!known) return
    const next = change(known)
    details.set(key, next)
    if (current.current === key) setDetail(next)
  }, [key])
  return { detail, loading, error, refresh: () => refresh(n => n + 1), update }
}
