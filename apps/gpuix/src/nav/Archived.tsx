// A project's archived threads, opened from the last row of its sidebar list. Archiving keeps everything: a thread
// opens here read-only (its page offers Unarchive in place of the composer), and Unarchive puts it back in the list.
// ↑/↓ browse, Enter opens.
import { useGpuix, type PublicInstance } from '@gpuix/react'
import { useEffect, useRef, useState } from 'react'
import { relativeTime } from '@/lib/format'
import { describe } from '../problems/describe.ts'
import { problemProps } from '../problems/props.ts'
import { ProblemState } from '../kit/Problem.tsx'
import { isChildThread, isInboundThread } from '../../../../packages/kybern-client/src/subagents.ts'
import type { Thread } from '../../../../packages/kybern-client/src/types.ts'
import { MatrixLoader } from '../MatrixLoader.tsx'
import { Button } from '../kit/Button.tsx'
import { toastProblem } from '../problems/toast.ts'
import { getClient, useApp } from '../state.ts'
import { Label, ProviderMark, useTheme } from '../ui.tsx'
import { unarchiveThread } from './actions.ts'
import { openThread } from './history.ts'
import { Dialog, DialogHeader, muted } from './overlay.tsx'
import { setNav, useNav } from './store.ts'

export function ArchivedDialog() {
  const archived = useNav((s) => s.archived)
  if (!archived) return null
  return <ArchivedList key={archived.projectId} projectId={archived.projectId} />
}

type Load = { state: 'loading' } | { state: 'ready'; threads: Thread[] } | { state: 'failed'; error: unknown }

function ArchivedList({ projectId }: { projectId: string }) {
  const t = useTheme()
  const { renderer } = useGpuix()
  const project = useApp((s) => s.projects.find((p) => p.id === projectId))
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [highlight, setHighlight] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const rowRefs = useRef(new Map<number, PublicInstance>())
  const close = () => setNav({ archived: null })

  useEffect(() => {
    let live = true
    setLoad({ state: 'loading' })
    const client = getClient()
    if (!client) return
    client
      .call('threads.list', { project_id: projectId, include_archived: true })
      .then((result) => {
        if (!live) return
        const threads = result.threads
          .filter((th) => th.status === 'archived' && !isChildThread(th) && !isInboundThread(th))
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        setLoad({ state: 'ready', threads })
      })
      .catch((error: unknown) => live && setLoad({ state: 'failed', error }))
    return () => { live = false }
  }, [projectId, attempt])

  const threads = load.state === 'ready' ? load.threads : []
  const active = Math.min(highlight, Math.max(0, threads.length - 1))
  const open = (thread: Thread | undefined) => {
    if (!thread) return
    close()
    openThread(thread.id)
  }
  const unarchive = async (thread: Thread) => {
    if (busy) return
    setBusy(thread.id)
    try {
      await unarchiveThread(thread.id)
      setLoad((current) => (current.state === 'ready' ? { state: 'ready', threads: current.threads.filter((th) => th.id !== thread.id) } : current))
    } catch (error) {
      toastProblem(error, { action: 'bring the thread back', projectId })
    } finally {
      setBusy(null)
    }
  }
  const latest = useRef(active)
  latest.current = active
  const move = (step: 1 | -1) => {
    if (!threads.length) return
    const next = Math.max(0, Math.min(threads.length - 1, latest.current + step))
    latest.current = next
    setHighlight(next)
    const el = rowRefs.current.get(next)
    if (el) renderer?.scrollIntoView?.(el.id)
  }

  return (
    <Dialog onClose={close} width={560} testId="archived-dialog">
      <DialogHeader title="Archived" description={project?.name} onClose={close} />
      <div
        testId="archived-list"
        autoFocus
        tabIndex={0}
        onKeyDown={(e) => {
          const key = e.key ?? ''
          if (key === 'escape') close()
          else if (key === 'down') move(1)
          else if (key === 'up') move(-1)
          else if (key === 'enter') open(threads[latest.current])
        }}
        style={{ display: 'flex', flexDirection: 'column', maxHeight: 420, overflowY: 'scroll', paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 12 }}
      >
        {threads.map((thread, at) => (
          // The row opens the thread; Unarchive sits beside it (a sibling, so its press does not open the thread too).
          <div
            key={thread.id}
            ref={(el) => {
              if (el) rowRefs.current.set(at, el)
              else rowRefs.current.delete(at)
            }}
            onMouseMove={() => {
              if (active !== at) setHighlight(at)
            }}
            style={{ position: 'relative', borderRadius: 10, ...(at === active ? { backgroundColor: t.buttonSecondaryHover } : {}) }}
          >
            <div
              testId={`archived-thread-${thread.id}`}
              onClick={() => open(thread)}
              style={{ display: 'flex', alignItems: 'center', gap: 12, height: 40, paddingLeft: 12, paddingRight: 112, cursor: 'pointer' }}
            >
              <div style={{ display: 'flex', width: 16, height: 16, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <ProviderMark kind={thread.provider.kind} size={14} />
              </div>
              <Label color={t.text} truncate style={{ flexGrow: 1, minWidth: 0 }}>
                {thread.title || 'Untitled'}
              </Label>
            </div>
            <div style={{ position: 'absolute', top: 0, bottom: 0, right: 8, display: 'flex', alignItems: 'center' }}>
              {at === active ? (
                <Button variant="secondary" size="sm" testId={`unarchive-${thread.id}`} busy={busy === thread.id} onClick={() => void unarchive(thread)}>
                  Unarchive
                </Button>
              ) : (
                <Label color={muted(t, 0.79)} size={12}>
                  {relativeTime(thread.updated_at)}
                </Label>
              )}
            </div>
          </div>
        ))}
        {load.state === 'loading' && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 96 }}>
            <MatrixLoader />
          </div>
        )}
        {load.state === 'ready' && threads.length === 0 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 96 }}>
            <Label color={muted(t, 0.79)}>No archived threads</Label>
          </div>
        )}
        {load.state === 'failed' && (
          <ProblemState {...problemProps(describe(load.error, { action: 'list the archived threads' }), { retry: () => setAttempt((n) => n + 1), projectId }, 'archived-problem')} />
        )}
      </div>
    </Dialog>
  )
}
