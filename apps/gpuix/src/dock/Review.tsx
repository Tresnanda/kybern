import { useEffect, useState } from 'react'
import type { GitStatus, Thread } from '../../../../packages/kybern-client/src/types.ts'
import { callThread, useApp } from '../state.ts'
import { ProblemState } from '../kit/Problem.tsx'
import { describe } from '../problems/describe.ts'
import { problemProps } from '../problems/props.ts'
import { Detail } from '../pulls/PrDetail.tsx'
import { goPage } from '../nav/history.ts'
import { Label, useTheme } from '../ui.tsx'
import { N } from '../nav/glyphs.ts'
import { Button } from '../kit/Button.tsx'
export function ReviewPane({ thread, width }: { thread: Thread; width: number }) {
  const t = useTheme()
  const project = useApp(s => s.projects.find(p => p.id === thread.project_id))
  const [git, setGit] = useState<GitStatus | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [revision, refresh] = useState(0)
  useEffect(() => {
    let alive = true
    setError(null)
    void callThread(thread.id, 'git.status', { thread_id: thread.id }).then(result => { if (alive) setGit(result) }, e => { if (alive) setError(e ?? new Error('Unknown failure')) })
    return () => { alive = false }
  }, [thread.id, thread.status, revision])
  if (git?.pull_request && project) return <div testId="dock-review" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}><Detail key={`${git.pull_request.repo ?? ''}:${git.pull_request.number}`} project={project} number={git.pull_request.number} repo={git.pull_request.repo} width={width} onBack={() => goPage('pulls')} onChanged={() => refresh(n => n + 1)} /></div>
  if (error) {
    const view = describe(error, { action: 'load this branch', goal: 'see this branch' })
    return <div testId="dock-review" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}><ProblemState {...problemProps(view, { retry: () => refresh(n => n + 1), projectId: thread.project_id }, 'dock-review-problem')} /></div>
  }
  return <div testId="dock-review" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 20 }}><Label color={t.textSecondary} size={12} style={{ textAlign: 'center' }}>{git ? 'No pull request is linked to this branch.' : 'Loading pull request…'}</Label><Button testId="dock-review-refresh" onClick={() => refresh(n => n + 1)}>Refresh branch</Button><Button variant="ghost" onClick={() => goPage('pulls')}>Open pull requests</Button></div>
}
