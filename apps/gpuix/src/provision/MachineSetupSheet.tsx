// Scoped composer setup. Each target keeps its own folder, explicit env consent and operation;
// retrying one machine never resubmits a successful or queued operation on another.
import { useWindowSize } from '@gpuix/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { PROVISION_CHANGED_NOTIFICATION, type ProvisionStatus, type ProvisionPlan, type ProjectsProvisionParams } from '../../../../packages/kybern-client/src/types.ts'
import { defaultPath, expandPath, pathAccepted, partialGroupDetail, provisionFraction, provisionSettled, provisionStatusText, type ProvisionTarget } from '../../../../packages/kybern-client/src/provision.ts'
import { Dialog } from '../nav/overlay.tsx'
import { errorText } from '../nav/actions.ts'
import { Button } from '../kit/Button.tsx'
import { Checkbox } from '../kit/Checkbox.tsx'
import { PickerChip } from '../kit/PickerChip.tsx'
import { DialogBody, DialogFooter, DialogHeader, ErrorText, Field, Hint } from '../environments/kit.tsx'
import { Label, useTheme } from '../ui.tsx'
import { machineHub } from '../machines/index.ts'
import { EnvFileList, FolderField, ProgressBar, useProvisionPlan } from './parts.tsx'
import { fixtureClient, provisionContextOf } from './targets.ts'
import { setupAttempts, type SetupAttempt } from './setupAttempts.ts'
import { MachineSymbol, SetupRoute, SetupStatus } from '../machines/SetupVisuals.tsx'

type Prepared = { ready: boolean; start: () => Promise<void> }

export function MachineSetupSheet({ projectId, targetId, close, onReady, onProvisioned, inline = false }: {
  projectId: string; targetId: string; close: () => void; onReady: (plan?: ProvisionPlan) => Promise<void>; onProvisioned?: (plan: ProvisionPlan) => void; inline?: boolean
}) {
  const t = useTheme()
  const size = useWindowSize({ intervalMs: 250 })
  const [context] = useState(() => provisionContextOf(projectId))
  const [sourceId, setSourceId] = useState(context?.source)
  const source = context?.instances.find((item) => item.machineId === sourceId)
  const client = useMemo(() => {
    try { return source ? fixtureClient() ?? machineHub().clientFor(source.machineId) : null } catch { return null }
  }, [source?.machineId])
  const missing = context?.targets.filter((item) => !item.has) ?? []
  const chosen = missing.find((item) => item.machineId === targetId)
  const [all, setAll] = useState(() => !!source && missing.some((item) => item.machineId !== targetId && setupAttempts.get(setupAttempts.key(source.machineId, source.projectId, item.machineId))))
  const targets = all ? missing : chosen ? [chosen] : []
  const prepared = useRef(new Map<string, Prepared>())
  const [readiness, setReadiness] = useState<Record<string, boolean>>({})
  const register = useCallback((id: string, next: Prepared | null) => {
    if (next) prepared.current.set(id, next); else prepared.current.delete(id)
    setReadiness((old) => old[id] === !!next?.ready ? old : { ...old, [id]: !!next?.ready })
  }, [])
  const plans = useRef(new Map<string, ProvisionPlan>())
  const completed = useRef(new Set<string>())
  const provisioned = useRef(onProvisioned)
  provisioned.current = onProvisioned
  const [statuses, setStatuses] = useState<Record<string, ProvisionStatus>>({})
  const report = useCallback((next: ProvisionStatus, plan: ProvisionPlan | null) => {
    setStarted(true)
    if (plan) plans.current.set(next.target, plan)
    if (plan && next.phase === 'done' && !completed.current.has(next.operation_id)) {
      completed.current.add(next.operation_id); provisioned.current?.(plan)
    }
    setStatuses((old) => ({ ...old, [next.target]: next }))
  }, [])
  const [started, setStarted] = useState(() => !!source && targets.some((item) => setupAttempts.get(setupAttempts.key(source.machineId, source.projectId, item.machineId))))
  const [adding, setAdding] = useState(false)
  const submitting = useRef(false)
  const [choosing, setChoosing] = useState(false)
  const busy = adding || choosing
  const [error, setError] = useState('')
  const [selected, setSelected] = useState(false)
  const selecting = useRef(false)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  const add = async () => {
    if (submitting.current || selecting.current || !targets.length || !targets.every((item) => prepared.current.get(item.machineId)?.ready)) return
    submitting.current = true; setStarted(true); setAdding(true)
    try { await Promise.all(targets.map((item) => prepared.current.get(item.machineId)!.start())) }
    finally { submitting.current = false; if (mounted.current) setAdding(false) }
  }
  const useTarget = async () => {
    if (selecting.current || submitting.current) return
    selecting.current = true; setChoosing(true); setError('')
    try { await onReady(plans.current.get(targetId)); if (mounted.current) setSelected(true) } catch (e) { if (mounted.current) setError(`${errorText(e)} Retry selecting the machine.`) } finally { selecting.current = false; if (mounted.current) setChoosing(false) }
  }
  const name = context?.name ?? 'this project'
  const done = statuses[targetId]?.phase === 'done'
  const dismiss = () => { if (!submitting.current && !selecting.current) close() }
  useEffect(() => { if (done && !adding) void useTarget() }, [done, adding])
  const content = <>
    <DialogHeader title={started ? `Setup for ${name}` : `Add ${name} to ${chosen?.machineName ?? 'this machine'}?`}
      description={started ? selected ? `Ready on ${chosen?.machineName ?? 'the selected machine'}. Your draft is preserved; send it when you’re ready.` : 'Each machine keeps its progress. Your selected machine switches when its setup finishes. Your draft is not sent.' : 'This project is missing or incomplete on this machine. Add it before starting a chat there.'} onClose={dismiss} />
    <DialogBody testId="machine-setup-body" footer scroll>
      {!client || !source ? <Hint>No machine with the complete project is online. Connect a machine that has it and reopen this sheet.</Hint> : <>
        <SetupRoute source={source.machineName} destination={all ? `${targets.length} machines` : chosen?.machineName ?? 'Selected machine'} />
        {!started && context!.instances.length > 1 && <Field label="From"><div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {context!.instances.map((item) => <PickerChip key={item.machineId} chevron={false} selected={sourceId === item.machineId} disabled={!item.online} label={`From ${item.machineName}`} onClick={() => setSourceId(item.machineId)}>{item.machineName}</PickerChip>)}
        </div></Field>}
        {!started && missing.length > 1 && <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Checkbox testId="machine-setup-all" aria-label="Add to all machines that don’t have it" checked={all} onCheckedChange={setAll} />
          <Label color={t.text} size={13} lineHeight={20}>Add to all machines that don’t have it</Label>
        </div>}
        <Hint>{`Targets: ${targets.map((item) => item.machineName).join(', ')}.${started ? '' : ' Choose env files separately for each machine.'}`}</Hint>
        {targets.map((item) => <SetupTarget key={`${source.machineId}:${item.machineId}`} sourceId={source.machineId} client={client} projectId={source.projectId} target={item} started={started} register={register} report={report} />)}
      </>}
      {!chosen && <>
        <Hint>This machine needs to join your network or resume before setup. Open Settings → Machines, enable or resume it, then reopen this sheet.</Hint>
        <Button variant="secondary" testId="machine-setup-settings" onClick={() => { close(); void import('../settings/SettingsScreen.tsx').then((m) => m.openSettingsTab('machines')) }}>Open machines settings</Button>
      </>}
      {error && <ErrorText>{error}</ErrorText>}
    </DialogBody>
    <DialogFooter>
      <Button size="lg" variant="secondary" testId="machine-setup-cancel" disabled={busy} onClick={dismiss}>{started ? 'Close' : 'Cancel'}</Button>
      {!started && <Button size="lg" icon="plus" variant="primary" testId="machine-setup-add" busy={busy} disabled={!client || !targets.length || !targets.every((item) => readiness[item.machineId])} onClick={() => void add()}>{all ? `Add to ${targets.length} machines` : 'Add project'}</Button>}
      {done && !selected && <Button size="lg" variant="primary" testId="machine-setup-use" busy={busy} onClick={() => void useTarget()}>Retry selection</Button>}
    </DialogFooter>
  </>
  return inline ? <div testId="machine-setup-sheet" style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 560, maxHeight: size.height - 150, minHeight: 0, flexShrink: 1, overflow: 'hidden', alignSelf: 'center', borderRadius: 16, backgroundColor: t.popover }}>{content}</div>
    : <Dialog testId="machine-setup-sheet" width={560} onClose={dismiss}>{content}</Dialog>
}

function SetupTarget({ client, sourceId, projectId, target, started, register, report }: {
  client: KybernClient; sourceId: string; projectId: string; target: ProvisionTarget; started: boolean
  register: (id: string, next: Prepared | null) => void; report: (status: ProvisionStatus, plan: ProvisionPlan | null) => void
}) {
  const t = useTheme()
  const key = setupAttempts.key(sourceId, projectId, target.machineId)
  const [saved] = useState(() => setupAttempts.get(key))
  const attemptRecord = useRef<SetupAttempt | undefined>(saved)
  const [path, setPath] = useState<string | null>(saved?.request.path ?? null)
  // Never inherit another target's selection or preselect a secret for an extra machine.
  const [env, setEnv] = useState<string[]>(saved?.request.env_files ?? [])
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState<ProvisionStatus | null>(saved?.status ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(saved?.error ?? '')
  const operation = useRef<string | null>(saved?.request.operation_id ?? null)
  const inFlight = useRef(false)
  const pendingRequest = useRef<ProjectsProvisionParams | null>(saved?.request ?? null)
  const pendingPlan = useRef<ProvisionPlan | null>(saved?.plan ?? null)
  const { plan, check, checking, error: planError } = useProvisionPlan(client, projectId, target.machineId, path, undefined, attempt)
  useEffect(() => { if (plan && path === null) setPath(defaultPath(plan)) }, [plan, path])
  const updateStatus = (next: ProvisionStatus) => {
    const previous = attemptRecord.current?.status
    if (previous && provisionSettled(previous) && previous.operation_id === next.operation_id && !provisionSettled(next)) return
    if (attemptRecord.current) attemptRecord.current.status = next
    setStatus(next)
  }
  // Subscribe before submitting; a fast local transfer can finish before the RPC response arrives.
  useEffect(() => client.onNotification(PROVISION_CHANGED_NOTIFICATION, (params) => {
    const next = params as ProvisionStatus
    if (next.operation_id === operation.current) updateStatus(next)
  }), [client])
  useEffect(() => { if (status) report(status, pendingPlan.current) }, [status, report])
  useEffect(() => {
    if (!status || provisionSettled(status)) return
    let live = true
    const poll = () => void client.call('projects.provision.status', { operation_id: status.operation_id }).then((next) => { if (live && next.operation_id === operation.current) updateStatus(next) }, () => {})
    const timer = setInterval(poll, 3000)
    poll()
    return () => { live = false; clearInterval(timer) }
  }, [client, status?.operation_id, status && provisionSettled(status)])
  const ready = !busy && !status && (!!pendingRequest.current || !!plan && !plan.blocked && !planError && !checking && !!path?.trim() && pathAccepted(check))
  const start = async () => {
    if (inFlight.current || !ready || (!plan && !pendingPlan.current)) return
    inFlight.current = true
    setBusy(true); setError('')
    // A lost response may still have queued the operation: retries reuse its id and exact consent.
    const options = pendingPlan.current ?? plan!
    const request = pendingRequest.current ?? { project_id: projectId, machine: target.machineId, operation_id: crypto.randomUUID(), path: expandPath(path!, options.target_home, options.target.os), env_files: [...env] }
    try {
      const record = attemptRecord.current ?? { request, plan: options, status: null, error: '' }
      setupAttempts.remember(key, record); attemptRecord.current = record
      pendingRequest.current = request; operation.current = request.operation_id!; pendingPlan.current ??= options
      const next = await client.call('projects.provision', request)
      updateStatus(attemptRecord.current?.status ?? next)
    } catch (e) {
      const message = `${errorText(e)} Reconnect and retry to confirm this setup. Its folder and env choices are kept.`
      if (attemptRecord.current) attemptRecord.current.error = message
      setError(message)
    } finally { inFlight.current = false; setBusy(false) }
  }
  useEffect(() => { register(target.machineId, { ready, start }) })
  useEffect(() => () => register(target.machineId, null), [target.machineId, register])
  const failed = status?.phase === 'failed' || status?.phase === 'cancelled'
  const retry = () => { if (inFlight.current) return; setupAttempts.forget(key); attemptRecord.current = undefined; operation.current = null; pendingRequest.current = null; pendingPlan.current = null; setStatus(null); setError(''); setAttempt((n) => n + 1) }
  return <div testId={`machine-setup-${target.machineId}`} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
      <MachineSymbol os={plan?.target.os} size={32} />
      <Label color={t.text} size={14} lineHeight={20} weight={600} style={{ flexGrow: 1, flexShrink: 1 }}>{target.machineName}</Label>
      {status && <SetupStatus kind={status.phase === 'done' ? 'ready' : failed ? 'error' : 'waiting'} text={status.phase === 'done' ? 'Added' : failed ? 'Needs attention' : status.phase === 'queued' ? 'Queued' : 'Adding'} />}
    </div>
    {!target.online && (!status || status.phase === 'queued') && <Hint>Offline · setup is queued until this machine returns.</Hint>}
    {status ? <>
      {!provisionSettled(status) && provisionFraction(status) !== null && <ProgressBar fraction={provisionFraction(status)} />}
      {failed ? <ErrorText>{provisionStatusText(status)}</ErrorText> : <Hint>{provisionStatusText(status)}</Hint>}
      {failed && <Button testId={`machine-setup-retry-${target.machineId}`} variant="secondary" disabled={busy} onClick={retry}>Change and retry</Button>}
    </> : <>
      {planError && <><ErrorText>{planError}</ErrorText><Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>Retry loading options</Button></>}
      {!plan && !planError && <Hint>Loading folder and env file options…</Hint>}
      {plan?.blocked && <ErrorText>{plan.blocked}</ErrorText>}
      {plan && !plan.blocked && <>
        {partialGroupDetail(plan) && <Hint>{partialGroupDetail(plan)}</Hint>}
        {plan.kind === 'group' && <Hint>{`Repositories: ${plan.repos.map((repo) => repo.path).join(', ')}`}</Hint>}
        <Field label={`Folder on ${target.machineName}`}><FolderField testId={`machine-setup-folder-${target.machineId}`} plan={plan} path={path ?? ''} onPath={setPath} check={check} checking={checking} disabled={busy || !!pendingRequest.current} /></Field>
        <Field label={`Env files for ${target.machineName}`}><EnvFileList testId={`machine-setup-env-${target.machineId}`} plan={plan} selected={env} onChange={setEnv} disabled={busy || !!pendingRequest.current} /></Field>
      </>}
      {error && <ErrorText>{error}</ErrorText>}
      {started && <Button testId={`machine-setup-submit-${target.machineId}`} variant="secondary" disabled={!ready} busy={busy} onClick={() => void start()}>{busy ? 'Adding…' : error ? 'Retry this machine' : 'Add to this machine'}</Button>}
    </>}
  </div>
}
