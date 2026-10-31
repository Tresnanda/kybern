// A job's log (ADE-97), read a page at a time: the window holds at most `LOG_WINDOW` lines and "Show earlier lines" / "Show
// later lines" read the next page, trimming the far end. A failed job opens a few lines before its last error, the cause above it a click away. Lines are monospace in virtual
// rows; GitHub's group markers become headings and ANSI colours map to tones, so no escape code is ever drawn.
import { useEffect, useMemo, useState } from 'react'
import { elapsed, failedStep, joinPage, LOG_PAGE, nextRead, openingOffset, parseLogLine, runBucket, windowFrom, type ActionsRepo, type LogTone, type LogWindow } from '../../../../../packages/kybern-client/src/actions.ts'
import type { WorkflowJob, WorkflowRun } from '../../../../../packages/kybern-client/src/types.ts'
import { AgentAction } from '../../kit/AgentAction.tsx'
import { Button } from '../../kit/Button.tsx'
import { IconButton } from '../../kit/IconButton.tsx'
import { toneColor } from '../../kit/tone.ts'
import { N } from '../../nav/glyphs.ts'
import { useApp } from '../../state.ts'
import { FONT_MONO, type Theme } from '../../theme.ts'
import { Label, useTheme } from '../../ui.tsx'
import { column, row } from '../../usage/controls.tsx'
import { prCall } from '../client.ts'
import { openUrl, PrLoading, Problem } from '../PrStates.tsx'
import { FixPopover } from './FixPopover.tsx'
import { RunGlyph } from './glyph.tsx'

function toneInk(t: Theme, tone: LogTone): string {
  switch (tone) {
    case 'error': return toneColor(t, 'danger')
    case 'warning': return toneColor(t, 'warning')
    case 'success': return toneColor(t, 'success')
    case 'info': case 'command': return toneColor(t, 'info')
    case 'muted': return t.textTertiary
    default: return t.text
  }
}

export function JobLog({ target, run, job, onRerun, rerunBusy }: { target: ActionsRepo; run: WorkflowRun; job: WorkflowJob; onRerun: () => void; rerunBusy: boolean }) {
  const t = useTheme()
  const connected = useApp(s => s.status === 'open')
  const member = target.repo ? { repo: target.repo } : {}
  const done = job.status === 'completed'
  const failed = done && runBucket(job) === 'failed'
  const [window, setWindow] = useState<LogWindow | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [paging, setPaging] = useState<'earlier' | 'later' | null>(null)
  const [fixOpen, setFixOpen] = useState(false)
  const [revision, retry] = useState(0)
  // The first read learns the length and the errors; a failure then opens on its last error.
  useEffect(() => {
    if (!done || !connected) return
    let canceled = false
    const read = (offset: number) => prCall(target.projectId, 'github.actions.log', { project_id: target.projectId, ...member, job_id: job.id, offset, limit: LOG_PAGE })
    void read(0).then(async first => {
      const start = openingOffset(first.total_lines, first.error_lines ?? [], failed)
      const page = start > 0 ? await read(start) : first
      if (!canceled) { setWindow(windowFrom(page)); setError(null) }
    }).catch(e => { if (!canceled) setError(String(e)) })
    return () => { canceled = true }
  }, [job.id, done, connected, revision])
  const page = (direction: 'earlier' | 'later') => {
    const next = window && nextRead(window, direction)
    if (!next || paging) return
    setPaging(direction)
    void prCall(target.projectId, 'github.actions.log', { project_id: target.projectId, ...member, job_id: job.id, ...next }).then(result => {
      setWindow(w => w ? joinPage(w, result, direction) : windowFrom(result)); setPaging(null)
    }, e => { setError(String(e)); setPaging(null) })
  }
  const lines = useMemo(() => window ? window.lines.map((raw, i) => ({ n: window.offset + i, ...parseLogLine(raw) })).filter(l => !l.hidden) : [], [window])
  const digits = String(window ? window.offset + window.lines.length : 1).length
  const step = failedStep(job)
  const time = elapsed(job.started_at, job.completed_at)
  return <div testId="actions-log" style={{ ...column, flexGrow: 1, flexShrink: 1, minWidth: 0, minHeight: 0 }}>
    <div style={{ ...row, gap: 8, minHeight: 44, flexShrink: 0, paddingLeft: 16, paddingRight: 10, borderBottomWidth: 1, borderColor: t.surfaceDivider }}>
      <RunGlyph item={job} />
      <div style={{ ...column, flexShrink: 1, minWidth: 0 }}>
        <Label color={t.text} size={13} lineHeight={18} weight={500} truncate>{job.name}</Label>
        {(step || time) && <Label color={t.textTertiary} size={12} lineHeight={16} truncate>{[step ? `Failed at ${step.name}` : '', time].filter(Boolean).join(' · ')}</Label>}
      </div>
      <div style={{ flexGrow: 1 }} />
      {failed && <div style={{ position: 'relative', display: 'flex' }}>
        <AgentAction testId="actions-fix" onClick={() => setFixOpen(!fixOpen)}>Fix with agent</AgentAction>
        {fixOpen && <FixPopover target={target} run={run} job={job} close={() => setFixOpen(false)} />}
      </div>}
      {done && <Button size="sm" variant="ghost" testId="actions-rerun-job" busy={rerunBusy} onClick={onRerun}>Rerun job</Button>}
      {job.url && <IconButton icon={N.external} size="sm" label="Open job on GitHub" onClick={() => openUrl(job.url)} />}
    </div>
    {!done ? <div style={{ ...column, gap: 10, padding: 20 }}>
      <Label color={t.text} size={14} weight={500}>{job.status === 'in_progress' ? 'This job is running' : 'This job is waiting for a runner'}</Label>
      <Label color={t.textSecondary} size={13} lineHeight={20}>GitHub publishes a job’s log when it finishes. Its steps update here as they run.</Label>
      {job.url && <Button size="sm" style={{ alignSelf: 'flex-start' }} onClick={() => openUrl(job.url)}>Follow live on GitHub</Button>}
    </div>
      : error && !window ? <div style={{ padding: 20 }}><Problem error={error} refresh={() => retry(n => n + 1)} /></div>
      : !window ? <div style={{ padding: 20 }}><PrLoading label="Loading log…" rows={6} /></div>
      : window.total === 0 ? <Label color={t.textSecondary} size={13} lineHeight={20} style={{ padding: 20 }}>This job wrote no log.</Label>
      : <virtual-list testId="actions-log-lines" estimatedItemHeight={18} style={{ flexGrow: 1, minHeight: 0, paddingTop: 6, paddingBottom: 12 }}>
        {window.offset > 0 && <div key="earlier" style={{ ...row, gap: 8, paddingLeft: 16, paddingTop: 4, paddingBottom: 8 }}>
          <Button size="sm" testId="actions-log-earlier" busy={paging === 'earlier'} onClick={() => page('earlier')}>Show earlier lines</Button>
          <Label color={t.textTertiary} size={12}>{`Lines ${(window.offset + 1).toLocaleString('en-US')}–${(window.offset + window.lines.length).toLocaleString('en-US')} of ${window.total.toLocaleString('en-US')}`}</Label>
        </div>}
        {lines.map(l => <div key={l.n} testId={l.tone === 'error' ? 'actions-log-error' : undefined} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, paddingLeft: 12, paddingRight: 16, ...(l.tone === 'group' ? { paddingTop: 6 } : {}), ...(l.tone === 'error' ? { backgroundColor: t.variant === 'dark' ? 'rgba(255, 99, 99, 0.10)' : 'rgba(220, 38, 38, 0.07)' } : {}) }}>
          <Label color={t.textTertiary} size={11.5} lineHeight={18} font={FONT_MONO} style={{ width: digits * 7.2 + 4, flexShrink: 0, textAlign: 'right' }}>{String(l.n + 1)}</Label>
          <Label color={l.tone === 'group' ? t.text : toneInk(t, l.tone)} size={12} lineHeight={18} weight={l.tone === 'group' ? 600 : undefined} font={FONT_MONO} style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, userSelect: 'text' }}>{l.text || ' '}</Label>
        </div>)}
        {nextRead(window, 'later') && <div key="later" style={{ ...row, paddingLeft: 16, paddingTop: 8 }}>
          <Button size="sm" testId="actions-log-later" busy={paging === 'later'} onClick={() => page('later')}>Show later lines</Button>
        </div>}
      </virtual-list>}
    {error && window && <Label color={t.red} size={12} lineHeight={16} style={{ padding: 10, paddingLeft: 16 }}>{`${error} Try again in a moment.`}</Label>}
  </div>
}
