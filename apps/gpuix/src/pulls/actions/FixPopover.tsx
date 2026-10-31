// "Fix with agent" on a failed job (ADE-97), the pull request page's Send to agent popover (`PrSend.tsx`) for CI: choose the
// conversation on the run's branch or a new one, see what will be sent, and send. The prompt names the job, the failed step,
// the run's link and a bounded excerpt of the log (`fixPrompt`); a new conversation gets a worktree from the run's branch.
import { useEffect, useState } from 'react'
import { failedStep, fixPrompt, type ActionsRepo } from '../../../../../packages/kybern-client/src/actions.ts'
import type { WorkflowJob, WorkflowRun } from '../../../../../packages/kybern-client/src/types.ts'
import { Button } from '../../kit/Button.tsx'
import { ensureLoaded, getData, useComposer } from '../../composer/store.ts'
import { PopupLayer, popoverStyle } from '../../composer/Menu.tsx'
import { openThread } from '../../nav/history.ts'
import { Menu, MenuItem } from '../../nav/overlay.tsx'
import { getNav } from '../../nav/store.ts'
import { refreshLists, useApp } from '../../state.ts'
import { Label, useTheme } from '../../ui.tsx'
import { column, row } from '../../usage/controls.tsx'
import { prCall, prClient } from '../client.ts'

/** Send the failure to `threadId`, or to a new conversation on the run's branch; resolves to the conversation's id. */
export async function sendFailure(target: ActionsRepo, run: WorkflowRun, job: WorkflowJob, threadId: string | undefined): Promise<string> {
  const client = prClient(target.projectId)
  const settings = getData().settings
  if (!client) throw new Error("This project's machine is offline. Try again when it's back.")
  if (!settings) throw new Error('Settings are still loading. Try again in a moment.')
  if (target.repo) throw new Error("A group project's repository can't get its own conversation yet. Open that repository as its own project, then try again.")
  const excerpt = await prCall(target.projectId, 'github.actions.log', { project_id: target.projectId, job_id: job.id, excerpt: true }).catch(() => null)
  const text = fixPrompt(run, job, excerpt?.lines ?? [])
  let thread = threadId
  if (!thread) {
    const create = (base?: string) => client.call('threads.create', {
      project_id: target.projectId,
      provider: { kind: settings.default_provider, instance: 'default' },
      permission_mode: settings.default_permission_mode,
      use_worktree: true,
      title: `Fix ${job.name}`,
      ...(base ? { base_branch: base } : {}),
    })
    // A tag or a deleted branch has no branch to start from: the project's own branch then.
    const created = await create(run.head_branch || undefined).catch(() => create())
    thread = created.id
  }
  await client.call('threads.send', { thread_id: thread, message: { parts: [{ type: 'text', text }] } })
  await refreshLists()
  return thread
}

export function FixPopover({ target, run, job, close }: { target: ActionsRepo; run: WorkflowRun; job: WorkflowJob; close: () => void }) {
  const t = useTheme()
  const threads = useApp(s => s.threads)
  const settings = useComposer(s => s.settings)
  useEffect(() => { ensureLoaded() }, [])
  const choices = threads.filter(th => th.project_id === target.projectId && !th.subagent && !th.delegation)
  const onBranch = choices.find(th => th.worktree?.branch === run.head_branch)
  const [choice, setChoice] = useState<string | 'new'>(onBranch?.id ?? 'new')
  const linked = choice === 'new' ? undefined : choices.find(th => th.id === choice)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const blocked = linked?.status === 'running' || linked?.status === 'awaiting-approval'
  const step = failedStep(job)
  const send = () => {
    setBusy(true); setError(null)
    void sendFailure(target, run, job, linked?.id).then(id => { close(); openThread(id) }, e => { setError(String(e)); setBusy(false) })
  }
  return <PopupLayer still={getNav().keyboardNav} testId="actions-fix-popover" side="bottom" align="end" sideOffset={6} tabIndex={0} onKeyDown={e => { if (e.key === 'escape') close() }} onMouseDownOutside={close} style={{ ...popoverStyle(t), ...column, width: 384, padding: 16, gap: 12 }}>
    <Label color={t.text} size={13} weight={500}>Fix with agent</Label>
    <Label color={t.textSecondary} size={12} lineHeight={17}>The agent reads the failure, fixes it on the branch and runs the checks locally. You push and rerun CI.</Label>
    <div style={{ ...row, justifyContent: 'space-between' }}>
      <Label color={t.textSecondary} size={12}>Conversation</Label>
      <Menu align="end" width={280} trigger={() => <Button chevron size="sm" testId="actions-fix-thread">{linked?.title ?? 'New conversation'}</Button>}>
        <MenuItem id="new" label="New conversation" onSelect={() => setChoice('new')} />
        {choices.slice(0, 30).map(th => <MenuItem key={th.id} id={th.id} label={th.title} {...(th.worktree?.branch === run.head_branch ? { detail: 'This branch' } : {})} onSelect={() => setChoice(th.id)} />)}
      </Menu>
    </div>
    <div style={{ ...column, gap: 2 }}>
      <Label color={t.textSecondary} size={11.5} truncate>{`${run.workflow_name} #${run.number} · ${run.head_branch}`}</Label>
      <Label color={t.text} size={13} truncate>{step ? `${job.name} failed at ${step.name}` : `${job.name} failed`}</Label>
      <Label color={t.textTertiary} size={11.5}>With the end of the job’s log and the run’s link.</Label>
    </div>
    {blocked && <Label color={t.textSecondary} size={12}>That conversation is busy. Choose another or wait for it to finish.</Label>}
    {error && <Label color={t.red} size={12} lineHeight={17}>{error}</Label>}
    <div style={{ ...row, justifyContent: 'flex-end' }}>
      <Button testId="actions-fix-send" variant="primary" busy={busy} disabled={busy || !settings || blocked} onClick={send}>{busy ? 'Sending…' : 'Send failure'}</Button>
    </div>
  </PopupLayer>
}
