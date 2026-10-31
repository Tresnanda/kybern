// Run workflow (ADE-97): start a `workflow_dispatch` workflow on a branch or tag with its inputs, read from the workflow file
// on that branch (`github.actions.workflow`): a choice is a menu, a boolean a switch, anything else a text field. Once GitHub
// lists the new run it counts as one the user started, so its finish is announced.
import { useEffect, useState } from 'react'
import { focusActions } from './store.ts'
import { type ActionsRepo } from '../../../../../packages/kybern-client/src/actions.ts'
import type { ActionsWorkflowResult, Workflow } from '../../../../../packages/kybern-client/src/types.ts'
import { Button } from '../../kit/Button.tsx'
import { TextField } from '../../kit/Field.tsx'
import { IconButton } from '../../kit/IconButton.tsx'
import { Select } from '../../kit/Select.tsx'
import { Skeleton } from '../../kit/Skeleton.tsx'
import { Switch } from '../../kit/Switch.tsx'
import { N } from '../../nav/glyphs.ts'
import { toast } from '../../shell/toasts.tsx'
import { Label, useTheme } from '../../ui.tsx'
import { column, row } from '../../usage/controls.tsx'
import { prCall } from '../client.ts'
import { markStarted, observe } from './watch.ts'

/** Look for the run a dispatch made for about 15 s: GitHub lists it a few seconds after accepting the dispatch. */
async function findDispatched(target: ActionsRepo, workflow: string, ref: string, since: number): Promise<number | null> {
  const member = target.repo ? { repo: target.repo } : {}
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2500))
    const listed = await prCall(target.projectId, 'github.actions.runs', { project_id: target.projectId, ...member, workflow, event: 'workflow_dispatch', branch: ref, per_page: 5 }).catch(() => null)
    const run = listed?.runs.find(r => Date.parse(r.created_at) >= since - 10_000 && (!listed.viewer || r.actor === listed.viewer))
    if (run) { markStarted(run.id); observe(target, listed!.runs, listed!.viewer); return run.id }
  }
  return null
}

export function Dispatch({ target, workflows, defaultBranch, ownBranch, initial, showBack, onClose, onStarted }: {
  target: ActionsRepo; workflows: Workflow[]; defaultBranch: string; ownBranch: string | null; initial: string; showBack: boolean
  onClose: () => void; onStarted: () => void
}) {
  const t = useTheme()
  const member = target.repo ? { repo: target.repo } : {}
  const runnable = workflows.filter(w => w.state === 'active')
  const [workflow, setWorkflow] = useState(() => runnable.find(w => String(w.id) === initial) ? initial : String(runnable[0]?.id ?? ''))
  const [ref, setRef] = useState(defaultBranch)
  const [appliedRef, setAppliedRef] = useState(defaultBranch)
  const [inputs, setInputs] = useState<{ key: string; result?: ActionsWorkflowResult; error?: string } | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { if (!ref && defaultBranch) { setRef(defaultBranch); setAppliedRef(defaultBranch) } }, [defaultBranch])
  const inputsKey = `${workflow}@${appliedRef}`
  useEffect(() => {
    if (!workflow) return
    let canceled = false
    void prCall(target.projectId, 'github.actions.workflow', { project_id: target.projectId, ...member, workflow, ...(appliedRef ? { ref: appliedRef } : {}) }).then(result => {
      if (canceled) return
      setInputs({ key: inputsKey, result })
      setValues(Object.fromEntries(result.inputs.map(i => [i.name, i.default ?? (i.kind === 'boolean' ? 'false' : i.kind === 'choice' ? i.options?.[0] ?? '' : '')])))
    }, e => { if (!canceled) setInputs({ key: inputsKey, error: String(e) }) })
    return () => { canceled = true }
  }, [inputsKey])
  const shown = inputs?.key === inputsKey ? inputs : null
  const fields = shown?.result?.inputs ?? []
  const missing = fields.filter(i => i.required && !values[i.name]?.trim()).map(i => i.name)
  const name = runnable.find(w => String(w.id) === workflow)?.name ?? 'Workflow'
  const canRun = !!workflow && !!ref.trim() && ref === appliedRef && !!shown?.result?.dispatchable && missing.length === 0 && !busy
  const run = () => {
    if (!canRun) return
    const started = Date.now()
    setBusy(true); setError(null)
    void prCall(target.projectId, 'github.actions.dispatch', { project_id: target.projectId, ...member, workflow, ref: ref.trim(), inputs: values }).then(() => {
      toast.success(`${name} started on ${ref.trim()}`, { description: 'It appears in the list in a few seconds.' })
      onStarted()
      void findDispatched(target, workflow, ref.trim(), started).then(id => {
        if (id !== null) { onStarted(); focusActions({ ...target, runId: id }) }
      })
    }, e => { setError(String(e)); setBusy(false) })
  }

  return <div testId="actions-dispatch" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, minWidth: 0 }}>
    <div style={{ ...row, gap: 6, minHeight: 46, flexShrink: 0, paddingLeft: 12, paddingRight: 12, borderBottomWidth: 1, borderColor: t.border }}>
      {showBack && <IconButton icon={N.arrowLeft} label="Back to runs" onClick={onClose} />}
      <Label color={t.text} size={14} weight={500} style={{ paddingLeft: showBack ? 0 : 8 }}>Run workflow</Label>
    </div>
    <div style={{ ...column, flexGrow: 1, minHeight: 0, overflowY: 'scroll' }}>
      <div style={{ ...column, gap: 20, width: '100%', maxWidth: 520, paddingLeft: 24, paddingRight: 24, paddingTop: 20, paddingBottom: 24 }}>
        {runnable.length === 0 ? <Label color={t.textSecondary} size={13} lineHeight={20}>This repository has no active workflows.</Label> : <>
          <Field label="Workflow">
            <Select testId="actions-dispatch-workflow" label="Workflow" value={workflow} options={runnable.map(w => ({ value: String(w.id), label: w.name }))} onValueChange={setWorkflow} />
          </Field>
          <Field label="Branch or tag" help={`The workflow file is read from this branch.${ownBranch && ownBranch !== ref ? ` You're on ${ownBranch}.` : ''}`}>
            <TextField testId="actions-dispatch-ref" label="Branch or tag" mono value={ref} placeholder={defaultBranch || 'main'} onChange={setRef} onBlur={() => setAppliedRef(ref.trim())} onKeyDown={e => { if (e.key === 'enter') setAppliedRef(ref.trim()) }} />
          </Field>
          <div style={{ height: 1, backgroundColor: t.surfaceDivider }} />
          {!shown ? <div style={{ ...column, gap: 10 }}><Skeleton width="40%" height={13} /><Skeleton width="100%" height={28} /></div>
            : shown.error ? <Label color={t.red} size={13} lineHeight={20}>{`${shown.error} Check the branch name and try again.`}</Label>
            : !shown.result!.dispatchable ? <div testId="actions-dispatch-unavailable"><Label color={t.textSecondary} size={13} lineHeight={20}>{`${name} can’t be started by hand: its file on ${appliedRef} has no workflow_dispatch trigger.`}</Label></div>
            : fields.length === 0 ? <Label color={t.textSecondary} size={13} lineHeight={20}>This workflow takes no inputs.</Label>
            : fields.map(input => <Field key={input.name} label={input.name} required={input.required} help={input.description}>
              {input.kind === 'boolean'
                ? <div style={{ ...row, gap: 8 }}><Switch aria-label={input.name} checked={values[input.name] === 'true'} onCheckedChange={on => setValues(v => ({ ...v, [input.name]: on ? 'true' : 'false' }))} /><Label color={t.textSecondary} size={13}>{values[input.name] === 'true' ? 'On' : 'Off'}</Label></div>
                : input.kind === 'choice' && input.options?.length
                  ? <Select label={input.name} value={values[input.name] ?? ''} options={input.options.map(o => ({ value: o, label: o }))} onValueChange={v => setValues(vs => ({ ...vs, [input.name]: v }))} />
                  : <TextField testId={`actions-dispatch-input-${input.name}`} label={input.name} value={values[input.name] ?? ''} placeholder={input.default || ''} onChange={v => setValues(vs => ({ ...vs, [input.name]: v }))} />}
            </Field>)}
          {error && <div role="alert"><Label color={t.red} size={13} lineHeight={20}>{error}</Label></div>}
          <div style={{ ...row, gap: 8, justifyContent: 'flex-end' }}>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" testId="actions-dispatch-run" busy={busy} disabled={!canRun} onClick={run}>Run workflow</Button>
          </div>
        </>}
      </div>
    </div>
  </div>
}

function Field({ label, required, help, children }: { label: string; required?: boolean; help?: string; children: React.ReactNode }) {
  const t = useTheme()
  return <div style={{ ...column, gap: 6 }}>
    <div style={{ ...row, gap: 4 }}>
      <Label color={t.text} size={13} lineHeight={18} weight={500}>{label}</Label>
      {required && <Label color={t.textTertiary} size={12} lineHeight={18}>Required</Label>}
    </div>
    {children}
    {help && <Label color={t.textTertiary} size={12} lineHeight={17}>{help}</Label>}
  </div>
}
