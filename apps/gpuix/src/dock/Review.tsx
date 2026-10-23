import { useEffect, useState } from 'react'
import type { GitStatus, Thread } from '../../../../packages/kybern-client/src/types.ts'
import { getClient, useApp } from '../state.ts'
import { Detail } from '../pulls/PrDetail.tsx'
import { goPage } from '../nav/history.ts'
import { Label, useTheme } from '../ui.tsx'
import { N } from '../nav/glyphs.ts'
import { DockEmpty, ErrorLine } from './parts.tsx'
import { Button } from '../kit/Button.tsx'
export function ReviewPane({ thread, width }: { thread: Thread; width: number }) {
  const t = useTheme()
  const project = useApp(s => s.projects.find(p => p.id === thread.project_id))
  const [git, setGit] = useState<GitStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revision, refresh] = useState(0)
  useEffect(() => {
    let alive = true
    setError(null)
    void getClient()!.call('git.status', { thread_id: thread.id }).then(result => { if (alive) setGit(result) }, e => { if (alive) setError(String(e)) })
    return () => { alive = false }
  }, [thread.id, thread.status, revision])
  if (git?.pull_request && project) return <div testId="dock-review" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}><Detail key={git.pull_request.number} project={project} number={git.pull_request.number} width={width} onBack={() => goPage('pulls')} onChanged={() => refresh(n => n + 1)} /></div>
  return <div testId="dock-review" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 20 }}><ErrorLine error={error} retry={() => refresh(n => n + 1)} /><Label color={t.textSecondary} size={12} style={{ textAlign: 'center' }}>{git || error ? 'No pull request is linked to this branch.' : 'Loading pull request…'}</Label><Button testId="dock-review-refresh" onClick={() => refresh(n => n + 1)}>Refresh branch</Button><Button variant="ghost" onClick={() => goPage('pulls')}>Open pull requests</Button></div>
}
