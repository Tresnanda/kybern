// "Add to another machine…" (ADE-86 provisioning): pick a machine that lacks the project, where it goes there and which env
// files come along, then follow it to "Added to os-kdi". Every call goes to the SOURCE machine (the one that sends it, any
// member that has the project); the folder chooser browses the TARGET. The work is an outbox item, so closing the sheet or
// an offline target does not stop it.
import { useEffect, useMemo, useState } from 'react'
import { PROVISION_CHANGED_NOTIFICATION, type ProvisionStatus } from '../../../../packages/kybern-client/src/types.ts'
import {
  PROVISION_COPY as COPY, defaultEnvFiles, defaultPath, displayPath, pathAccepted, provisionFraction, provisionSettled, provisionStatusText, targetDetail, type ProvisionTarget,
} from '../../../../packages/kybern-client/src/provision.ts'
import { Dialog } from '../nav/overlay.tsx'
import { errorText } from '../nav/actions.ts'
import { Button } from '../kit/Button.tsx'
import { PickerChip } from '../kit/PickerChip.tsx'
import { Radio } from '../kit/Radio.tsx'
import { RADIUS, useControls } from '../kit/controls.ts'
import { MachineBadge } from '../sidebar/MachineBadge.tsx'
import { glyphOfMachine, machineHub } from '../machines/index.ts'
import { DialogBody, DialogFooter, DialogHeader, ErrorText, Field, Hint } from '../environments/kit.tsx'
import { Label, useTheme } from '../ui.tsx'
import { EnvFileList, FolderField, ProgressBar, useProvisionPlan } from './parts.tsx'
import { provisionContextOf } from './targets.ts'

export function ProvisionSheet({ projectId, machineId, close }: { projectId: string; machineId?: string; close: () => void }) {
  const t = useTheme()
  const [sourceId, setSourceId] = useState<string | null>(null)
  const context = useMemo(() => provisionContextOf(projectId, machineId, sourceId), [projectId, machineId, sourceId])
  const source = context?.instances.find((instance) => instance.machineId === context.source) ?? null
  const choosable = context?.targets.filter((target) => !target.has) ?? []
  const [targetId, setTargetId] = useState<string | null>(null)
  const target = choosable.find((item) => item.machineId === targetId) ?? choosable[0] ?? null
  const sourceClient = useMemo(() => (source ? machineHub().clientFor(source.machineId) : null), [source?.machineId])
  const [path, setPath] = useState<string | null>(null)
  const [env, setEnv] = useState<string[] | null>(null)
  const { plan, check, checking, error: planError } = useProvisionPlan(sourceClient, source?.projectId ?? projectId, target?.machineId ?? null, path)
  // A new target proposes its own folder and keeps the env selection to its defaults.
  useEffect(() => { setPath(null) }, [target?.machineId, source?.machineId])
  useEffect(() => { if (plan && path === null) setPath(defaultPath(plan)) }, [plan, path])
  useEffect(() => { if (plan && env === null) setEnv(defaultEnvFiles(plan.env_files)) }, [plan, env])
  const [status, setStatus] = useState<ProvisionStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!status || !sourceClient || provisionSettled(status)) return
    const stop = sourceClient.onNotification(PROVISION_CHANGED_NOTIFICATION, (params) => {
      const next = params as ProvisionStatus
      if (next.operation_id === status.operation_id) setStatus(next)
    })
    return stop
  }, [status?.operation_id, sourceClient, status && provisionSettled(status)])
  const project = plan?.project_name ?? context?.name ?? 'this project'
  const ready = !!plan && !plan.blocked && !!target && !checking && (path ?? '').trim() !== '' && pathAccepted(check)
  const add = async () => {
    if (!ready || !sourceClient || !target || !source) return
    setBusy(true); setError('')
    try {
      const started = await sourceClient.call('projects.provision', { project_id: source.projectId, machine: target.machineId, path: path!.trim(), env_files: env ?? [] })
      setStatus(started)
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  const dismiss = () => { if (!busy) close() }
  const running = !!status && !provisionSettled(status)
  const title = COPY.sheetTitle(project)

  if (status) {
    const done = status.phase === 'done'
    const failed = status.phase === 'failed' || status.phase === 'cancelled'
    const where = status.result?.project.path ?? status.path ?? ''
    return <Dialog onClose={dismiss} width={560} testId="provision-sheet">
      <DialogHeader title={done ? `Added to ${status.target_name}` : failed ? `Unable to add ${project}` : COPY.adding(status.target_name)} description={done ? `${project} is in the sidebar on ${status.target_name} now.` : failed ? 'Nothing else changed on either machine.' : 'You can close this; it keeps going and waits if the machine goes offline.'} onClose={dismiss} />
      <DialogBody footer>
        <div testId="provision-status" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <TargetSummary machineId={status.target} name={status.target_name} line={where ? displayPath(where, plan?.target_home, plan?.target.os) : ''} />
          {!done && <ProgressBar fraction={provisionFraction(status)} failed={failed} />}
          {failed ? <ErrorText testId="provision-error">{provisionStatusText(status)}</ErrorText> : <Label color={t.textSecondary} size={13} lineHeight={20}>{provisionStatusText(status)}</Label>}
        </div>
      </DialogBody>
      <DialogFooter>
        {failed && <Button size="lg" variant="secondary" testId="provision-retry" onClick={() => setStatus(null)}>Change and try again</Button>}
        <Button size="lg" variant={running ? 'secondary' : 'primary'} testId="provision-done" onClick={close}>{running ? 'Close' : COPY.done}</Button>
      </DialogFooter>
    </Dialog>
  }

  return <Dialog onClose={dismiss} width={560} testId="provision-sheet">
    <DialogHeader title={title} description={COPY.sheetDescription} onClose={dismiss} />
    <DialogBody footer scroll>
      {!context || !source ? <Hint>{context ? `No machine that has ${project} is online to send it.` : 'This project is not on any machine of your network.'}</Hint> : <>
        {context.instances.length > 1 && <Field label={COPY.from}><div role="radiogroup" aria-label={COPY.from} style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {context.instances.map((instance) => <PickerChip key={instance.machineId} testId={`provision-from-${instance.machineId}`} chevron={false} selected={instance.machineId === source.machineId} disabled={!instance.online || busy} secondary={instance.online ? undefined : 'Offline'} label={`From ${instance.machineName}`} onClick={() => setSourceId(instance.machineId)}>{instance.machineName}</PickerChip>)}
        </div></Field>}
        <Field label={COPY.machine}><div role="radiogroup" aria-label={COPY.machine} style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {context.targets.map((item) => <TargetTile key={item.machineId} item={item} project={project} checked={target?.machineId === item.machineId} disabled={busy || item.has} onSelect={() => setTargetId(item.machineId)} />)}
        </div></Field>
        {choosable.length === 0 && <Hint>{`Every machine in your network already has ${project}.`}</Hint>}
        {planError && <ErrorText testId="provision-plan-error">{planError}</ErrorText>}
        {plan?.blocked && <ErrorText testId="provision-blocked">{plan.blocked}</ErrorText>}
        {target && !plan && !planError && <Hint>{`Asking ${target.machineName} where it keeps projects…`}</Hint>}
        {plan && !plan.blocked && <>
          <Field label={COPY.folder}><FolderField plan={plan} path={path ?? ''} onPath={setPath} check={check} checking={checking} disabled={busy} /></Field>
          <Field label={COPY.envFiles}><EnvFileList plan={plan} selected={env ?? []} onChange={setEnv} disabled={busy} /></Field>
        </>}
        {error && <ErrorText testId="provision-start-error">{error}</ErrorText>}
      </>}
    </DialogBody>
    <DialogFooter>
      <Button size="lg" variant="secondary" disabled={busy} onClick={dismiss}>Cancel</Button>
      <Button size="lg" variant="primary" testId="provision-confirm" busy={busy} disabled={!ready} onClick={() => void add()}>{target ? COPY.add(target.machineName) : 'Add'}</Button>
    </DialogFooter>
  </Dialog>
}

/** A machine as a half-width tile, like the fork sheet's: badge, name, and whether it can take the project. */
function TargetTile({ item, project, checked, disabled, onSelect }: { item: ProvisionTarget; project: string; checked: boolean; disabled: boolean; onSelect: () => void }) {
  const t = useTheme()
  const c = useControls()
  return (
    <div
      testId={`provision-machine-${item.machineId}`} role="radio" aria-checked={checked} aria-label={item.machineName} aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : 0}
      onClick={disabled ? undefined : onSelect}
      onKeyDown={(e) => { if (!disabled && (e.key === 'enter' || e.key === 'space')) onSelect() }}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, flexBasis: 0, flexGrow: 1, minWidth: 236, paddingTop: 8, paddingBottom: 8, paddingLeft: 10, paddingRight: 10, borderRadius: RADIUS.lg,
        borderWidth: 1, borderColor: checked ? c.focus : c.ink(0.08), backgroundColor: checked ? c.optionSelected : 'rgba(0, 0, 0, 0)', cursor: disabled ? 'default' : 'pointer', opacity: item.has ? 0.6 : 1,
        ...(disabled ? {} : { hover: { backgroundColor: checked ? c.optionSelected : c.ink(0.04) }, focusVisible: { outlineWidth: 2, outlineColor: c.focus, outlineOffset: 0 } }),
      }}
    >
      <div style={{ display: 'flex', opacity: item.online ? 1 : 0.55 }}><MachineBadge glyph={glyphOfMachine(item.machineId)} size={20} /></div>
      <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, flexShrink: 1, minWidth: 0, pointerEvents: 'none' }}>
        <Label color={t.text} size={14} lineHeight={20} weight={500} truncate>{item.machineName}</Label>
        <Label color={t.textSecondary} size={12} lineHeight={16} truncate>{targetDetail(item, project)}</Label>
      </div>
      {!item.has && <Radio checked={checked} disabled={disabled} />}
    </div>
  )
}

function TargetSummary({ machineId, name, line }: { machineId: string; name: string; line: string }) {
  const t = useTheme()
  return <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
    <MachineBadge glyph={glyphOfMachine(machineId)} size={20} />
    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
      <Label color={t.text} size={14} lineHeight={20} weight={500} truncate>{name}</Label>
      {line && <Label color={t.textSecondary} size={12} lineHeight={16} truncate>{line}</Label>}
    </div>
  </div>
}
