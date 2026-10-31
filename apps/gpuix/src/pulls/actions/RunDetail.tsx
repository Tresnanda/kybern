// One workflow run (ADE-97): its status, branch, commit and trigger, the run actions (rerun failed jobs, rerun all, cancel),
// its jobs with their steps, and the selected job's log. Wide, the jobs sit in a column beside the log; narrow, above it.
// The run is read again every 10 s while it is in progress and the window is visible, every 60 s otherwise.
import { useEffect, useState } from 'react'
import { BUCKET_TONE, elapsed, eventWord, failedStep, isActive, refreshDelay, runBucket, runWord, type ActionsRepo } from '../../../../../packages/kybern-client/src/actions.ts'
import type { ActionsActionKind, ActionsRunResult, WorkflowJob, WorkflowRun } from '../../../../../packages/kybern-client/src/types.ts'
import { Icon } from '../../icons.tsx'
import { Button } from '../../kit/Button.tsx'
import { RADIUS } from '../../kit/controls.ts'
import { IconButton } from '../../kit/IconButton.tsx'
import { StatusChip } from '../../kit/StatusChip.tsx'
import { toneColor } from '../../kit/tone.ts'
import { N } from '../../nav/glyphs.ts'
import { Menu, MenuItem } from '../../nav/overlay.tsx'
import { useApp } from '../../state.ts'
import { FONT_MONO } from '../../theme.ts'
import { ink, Label, useTheme } from '../../ui.tsx'
import { column, row } from '../../usage/controls.tsx'
import { prCall } from '../client.ts'
import { copy, openUrl, PrLoading, Problem } from '../PrStates.tsx'
import { BUCKET_GLYPH, RunGlyph } from './glyph.tsx'
import { JobLog } from './JobLog.tsx'
import { markStarted } from './watch.ts'

/** Below this width the jobs stack above the log. */
const SPLIT = 760

/** The job a run opens on: the first failure, else the first one running, else the first. */
function firstJob(jobs: readonly WorkflowJob[]): WorkflowJob | undefined {
  return jobs.find(j => runBucket(j) === 'failed') ?? jobs.find(j => isActive(j)) ?? jobs[0]
}

export function RunDetail({ target, runId, listed, width, showBack, visible, onBack, onActive, onChanged }: {
  target: ActionsRepo; runId: number; listed?: WorkflowRun; width: number; showBack: boolean; visible: boolean
  onBack: () => void; onActive: (active: boolean) => void; onChanged: () => void
}) {
  const t = useTheme()
  const connected = useApp(s => s.status === 'open')
  const member = target.repo ? { repo: target.repo } : {}
  const [detail, setDetail] = useState<ActionsRunResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revision, refresh] = useState(0)
  const [jobId, setJobId] = useState<number | null>(null)
  const [busy, setBusy] = useState<ActionsActionKind | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => {
    if (!connected) return
    let canceled = false
    void prCall(target.projectId, 'github.actions.run', { project_id: target.projectId, ...member, run_id: runId }).then(next => {
      if (canceled) return
      setDetail(next); setError(null)
    }, e => { if (!canceled) setError(String(e)) })
    return () => { canceled = true }
  }, [runId, revision, connected])
  const run = detail?.run ?? listed
  const active = !!run && isActive(run)
  useEffect(() => { onActive(active); return () => onActive(false) }, [active])
  useEffect(() => {
    const delay = refreshDelay({ active, onScreen: true, windowVisible: visible })
    if (delay === null || !detail) return
    const timer = setTimeout(() => refresh(n => n + 1), delay)
    return () => clearTimeout(timer)
  }, [active, visible, detail])
  const jobs = detail?.jobs ?? []
  const job = jobs.find(j => j.id === jobId) ?? firstJob(jobs)

  const act = (action: ActionsActionKind, job?: WorkflowJob) => {
    if (!run || busy) return
    setBusy(action); setActionError(null); setNotice(null)
    void prCall(target.projectId, 'github.actions.action', { project_id: target.projectId, ...member, action, run_id: run.id, ...(job ? { job_id: job.id } : {}) }).then(() => {
      if (action !== 'cancel') markStarted(run.id)
      setNotice(action === 'cancel' ? 'Cancel requested. GitHub stops the jobs in a few seconds.' : 'Rerun requested. New jobs appear here in a few seconds.')
      setBusy(null); refresh(n => n + 1); onChanged()
    }, e => { setActionError(String(e)); setBusy(null) })
  }

  const split = width >= SPLIT
  const failed = !!run && runBucket(run) === 'failed'
  return <div testId="actions-run" style={{ ...column, flexGrow: 1, minHeight: 0, minWidth: 0 }}>
    <div style={{ ...row, gap: 6, minHeight: 46, flexShrink: 0, paddingLeft: 12, paddingRight: 12, borderBottomWidth: 1, borderColor: t.border }}>
      {showBack && <IconButton icon={N.arrowLeft} label="Back to runs" testId="actions-back" onClick={onBack} />}
      {run && <RunStatus run={run} />}
      <div style={{ flexGrow: 1 }} />
      {run && active && <Button size="sm" danger testId="actions-cancel" busy={busy === 'cancel'} disabled={!!busy} onClick={() => act('cancel')}>Cancel run</Button>}
      {run && !active && <Button size="sm" testId="actions-rerun-all" variant={failed ? 'secondary' : 'primary'} busy={busy === 'rerun'} disabled={!!busy} onClick={() => act('rerun')}>Rerun all jobs</Button>}
      {run && !active && failed && <Button size="sm" variant="primary" testId="actions-rerun-failed" busy={busy === 'rerun_failed'} disabled={!!busy} onClick={() => act('rerun_failed')}>Rerun failed jobs</Button>}
      {run && <Menu testId="actions-run-more" align="end" trigger={() => <IconButton icon={N.ellipsis} label="More run actions" testId="actions-run-more-trigger" />}>
        <MenuItem id="refresh" label="Refresh" onSelect={() => refresh(n => n + 1)} />
        <MenuItem id="copy" label="Copy link" onSelect={() => copy(run.url)} />
        <MenuItem id="github" label="Open on GitHub" onSelect={() => openUrl(run.url)} />
      </Menu>}
    </div>
    {error && !detail && <div style={{ padding: 24 }}><Problem error={error} refresh={() => refresh(n => n + 1)} /></div>}
    {!run && !error && <div style={{ padding: 24 }}><PrLoading label="Loading run…" /></div>}
    {run && <>
      <RunSummary run={run} />
      {(actionError || notice) && <div role={actionError ? 'alert' : 'status'} style={{ paddingLeft: 20, paddingRight: 20, paddingBottom: 10 }}>
        <Label color={actionError ? t.red : t.textSecondary} size={12.5} lineHeight={18}>{actionError ?? notice!}</Label>
      </div>}
      <div style={{ display: 'flex', flexDirection: split ? 'row' : 'column', flexGrow: 1, minHeight: 0, borderTopWidth: 1, borderColor: t.surfaceDivider }}>
        <div testId="actions-jobs" style={{ ...column, width: split ? 272 : '100%', flexShrink: 0, ...(split ? {} : { maxHeight: 220 }), overflowY: 'scroll', paddingTop: 8, paddingBottom: 8, paddingLeft: 8, paddingRight: 8, ...(split ? { borderRightWidth: 1 } : { borderBottomWidth: 1 }), borderColor: t.surfaceDivider }}>
          {!detail && <div style={{ padding: 12 }}><PrLoading label="Loading jobs…" kind="list" rows={3} /></div>}
          {detail && jobs.length === 0 && <Label color={t.textSecondary} size={13} lineHeight={20} style={{ padding: 12 }}>{active ? 'Waiting for a runner to pick up the jobs.' : 'This run has no jobs.'}</Label>}
          {jobs.map(j => <JobRow key={j.id} job={j} selected={j.id === job?.id} onSelect={() => setJobId(j.id)} />)}
        </div>
        {job && <JobLog key={job.id} target={target} run={run} job={job} onRerun={() => act('rerun_job', job)} rerunBusy={busy === 'rerun_job'} />}
      </div>
    </>}
  </div>
}

function RunStatus({ run }: { run: WorkflowRun }) {
  const bucket = runBucket(run)
  return <StatusChip testId="actions-run-status" tone={BUCKET_TONE[bucket]} icon={BUCKET_GLYPH[bucket]}>{runWord(run)}</StatusChip>
}

/** The run's title and one line of facts: workflow and number, attempt, branch, commit, trigger, who and how long. */
function RunSummary({ run }: { run: WorkflowRun }) {
  const t = useTheme()
  const facts = [
    `${run.workflow_name} #${run.number}${run.attempt > 1 ? ` · attempt ${run.attempt}` : ''}`,
    eventWord(run.event),
    run.actor ? `by ${run.actor}` : '',
    isActive(run) ? `running ${elapsed(run.started_at ?? run.created_at, undefined)}` : elapsed(run.started_at ?? run.created_at, run.updated_at),
  ].filter(Boolean)
  return <div style={{ ...column, gap: 6, paddingLeft: 20, paddingRight: 20, paddingTop: 16, paddingBottom: 14 }}>
    <Label color={t.text} size={17} lineHeight={22} weight={600} style={{ lineClamp: 2, textOverflow: 'ellipsis' }}>{run.title || run.workflow_name}</Label>
    <div style={{ ...row, flexWrap: 'wrap', columnGap: 10, rowGap: 4 }}>
      {run.head_branch && <div style={{ ...row, gap: 4 }}><Icon source={N.branch} size={12} color={t.textSecondary} /><Label color={t.textSecondary} size={12.5} lineHeight={18}>{run.head_branch}</Label></div>}
      <Label color={t.textSecondary} size={12} lineHeight={18} font={FONT_MONO}>{run.head_sha.slice(0, 7)}</Label>
      <Label color={t.textSecondary} size={12.5} lineHeight={18}>{facts.join(' · ')}</Label>
    </div>
  </div>
}

/** A job and, while it is selected, its steps. */
function JobRow({ job, selected, onSelect }: { job: WorkflowJob; selected: boolean; onSelect: () => void }) {
  const t = useTheme()
  const time = elapsed(job.started_at, job.completed_at)
  const failing = failedStep(job)
  return <div style={column}>
    <div testId={`actions-job-${job.id}`} role="button" tabIndex={0} aria-current={selected ? 'true' : undefined} aria-label={`${job.name}, ${runWord(job)}`}
      onClick={onSelect} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') onSelect() }}
      style={{ ...row, alignItems: 'flex-start', gap: 8, paddingLeft: 8, paddingRight: 8, paddingTop: 7, paddingBottom: 7, borderRadius: RADIUS.sm, backgroundColor: selected ? ink(t, .07) : 'transparent', hover: { backgroundColor: selected ? ink(t, .07) : t.hover } }}>
      <div style={{ paddingTop: 2 }}><RunGlyph item={job} /></div>
      <div style={{ ...column, flexGrow: 1, flexShrink: 1, gap: 2 }}>
        <Label color={t.text} size={13} lineHeight={18} weight={selected ? 500 : 400} style={{ lineClamp: 2, textOverflow: 'ellipsis' }}>{job.name}</Label>
        {failing && !selected && <Label color={t.textTertiary} size={12} lineHeight={16} truncate>{`Failed at ${failing.name}`}</Label>}
      </div>
      {time && <Label color={t.textTertiary} size={12} lineHeight={18} style={{ flexShrink: 0 }}>{time}</Label>}
    </div>
    {selected && job.steps.length > 0 && <div testId="actions-steps" style={{ ...column, paddingLeft: 22, paddingBottom: 6 }}>
      {job.steps.map(s => {
        const bucket = runBucket(s)
        return <div key={s.number} testId={`actions-step-${s.number}`} style={{ ...row, gap: 7, minHeight: 24, paddingLeft: 8, paddingRight: 8 }}>
          <RunGlyph item={s} size={12} />
          <Label color={bucket === 'failed' ? toneColor(t, 'danger') : bucket === 'skipped' ? t.textTertiary : t.textSecondary} size={12.5} lineHeight={17} weight={bucket === 'failed' ? 500 : 400} truncate style={{ flexGrow: 1 }}>{s.name}</Label>
          <Label color={t.textTertiary} size={11.5} lineHeight={17} style={{ flexShrink: 0 }}>{elapsed(s.started_at, s.completed_at)}</Label>
        </div>
      })}
    </div>}
  </div>
}
