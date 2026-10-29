// "Fork to another machine…" (design §7.1): pick a machine that has the project, read and edit the hand-off note, and
// fork. The daemon snapshots the work to a branch, sends it to the machine and starts a thread there; the source thread
// gets a notice when it arrives (`transcript/rows.tsx`). Both threads stay live. An offline machine receives the fork
// when it is back, through the outbox. In `move` mode ("Continue on another machine…", design §7.2) the same sheet moves
// the thread instead: the work and the conversation go there and this thread becomes read-only with a link.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useGpuix, type PublicInstance } from '@gpuix/react'
import { forkParams, forkQueuedText, forkSheetDefaults, type ForkInstance } from '../../../../packages/kybern-client/src/forkMachine.ts'
import { moveParams, moveQueuedText } from '../../../../packages/kybern-client/src/continueOn.ts'
import { agentLine, defaultAgent, machineChoiceDetail, noAgentWarning, targetModel, type KindedChoice } from '../../../../packages/kybern-client/src/machineAgents.ts'
import { findModel, modelQualifier, triggerTraits } from '../../../../packages/kybern-client/src/models.ts'
import type { ProviderKind, ProviderModel } from '../../../../packages/kybern-client/src/types.ts'
import { useMachineAgents } from '../machines/agents.ts'
import { ModelPicker, ModelTriggerLabel } from '../composer/ModelPicker.tsx'
import { loadMachineLists, useComposer, type RemoteLists } from '../composer/store.ts'
import { formatEffort } from '@/lib/format'
import { nativeCapabilities } from '../native/api.ts'
import { Dialog } from '../nav/overlay.tsx'
import { errorText } from '../nav/actions.ts'
import { callThread, useApp } from '../state.ts'
import { toast } from '../shell/toasts.tsx'
import { Button } from '../kit/Button.tsx'
import { Checkbox } from '../kit/Checkbox.tsx'
import { Radio } from '../kit/Radio.tsx'
import { PickerChip } from '../kit/PickerChip.tsx'
import { RADIUS, useControls } from '../kit/controls.ts'
import { MachineBadge } from '../sidebar/MachineBadge.tsx'
import { glyphOfMachine } from '../machines/index.ts'
import { TextArea } from '../kit/TextArea.tsx'
import { DialogBody, DialogFooter, DialogHeader, ErrorText, Field, Hint } from '../environments/kit.tsx'
import { Label, useTheme } from '../ui.tsx'
import { forkTargetsOf } from './targets.ts'
import { provisionContextOf } from '../provision/targets.ts'
import { FolderField, useProvisionPlan } from '../provision/parts.tsx'
import { defaultPath, displayPath, notYetDetail, pathAccepted } from '../../../../packages/kybern-client/src/provision.ts'
import { ownProjectOf } from '../machines/merged.ts'
import { threadClient } from '../state.ts'

/** A machine of the sheet: one that has the project, or one it will be added to first. */
type SheetTarget = ForkInstance & { missing?: boolean }

export function ForkSheet({ threadId, machineId, close, mode = 'fork' }: { threadId: string; machineId?: string; close: () => void; mode?: 'fork' | 'move' }) {
  const move = mode === 'move'
  const t = useTheme()
  const thread = useApp((s) => s.threads.find((item) => item.id === threadId && item.machineId === machineId))
  // Machines without the project are offered too: the daemon adds it there first, then forks or moves.
  const targets = useMemo<SheetTarget[]>(() => {
    if (!thread) return []
    const having = forkTargetsOf(thread)
    const context = thread.subagent ? null : provisionContextOf(ownProjectOf(thread), thread.machineId)
    const missing = (context?.targets ?? []).filter((item) => !item.has).map((item) => ({ machineId: item.machineId, machineName: item.machineName, projectId: '', online: item.online, missing: true }))
    return [...having, ...missing]
  }, [thread])
  const [state, setState] = useState(() => forkSheetDefaults(targets, ''))
  const [generated, setGenerated] = useState<string | null>(null)
  const [noteError, setNoteError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // The note is written by the thread's own machine; the sheet opens at once and the field fills when it is ready.
  useEffect(() => {
    let live = true
    callThread(threadId, 'threads.fork_note', { thread_id: threadId }, machineId).then(
      (result) => { if (live) { setGenerated(result.note); setState((current) => ({ ...current, note: result.note })) } },
      (e) => { if (live) { setGenerated(''); setNoteError(`Unable to write the hand-off note. ${errorText(e)} Write one yourself, or fork without it.`) } },
    )
    return () => { live = false }
  }, [threadId, machineId])
  // A filled field puts the caret at the end, and the note is read from its title down, so it opens at the top. The host
  // takes the text and lays it out over the next frames while the sheet settles, so keep the caret there for a moment,
  // until the note is focused.
  const { renderer } = useGpuix()
  const noteField = useRef<PublicInstance>(null)
  const noteTouched = useRef(false)
  useEffect(() => {
    if (!generated || !renderer) return
    // Selecting where the caret already is does not scroll the field, so step off the first character and back.
    const toTop = () => {
      const field = noteField.current
      if (!field || noteTouched.current) return
      try {
        const caps = nativeCapabilities(renderer)
        caps.setInputSelection(field.id, 1, 1, false)
        caps.setInputSelection(field.id, 0, 0, false)
      } catch { /* Not committed yet, or an older addon: the caret stays at the end. */ }
    }
    const timer = setInterval(toTop, 100)
    const stop = setTimeout(() => clearInterval(timer), 1500)
    return () => { clearInterval(timer); clearTimeout(stop) }
  }, [generated, renderer])
  const target = targets.find((item) => item.machineId === state.machine) ?? targets[0]
  // A machine without the project: where it goes there (proposed by that machine, changeable) travels with the fork.
  const [sourceClient] = useState(() => { try { return threadClient(threadId, machineId) } catch { return null } })
  const [addPath, setAddPath] = useState<string | null>(null)
  const [changing, setChanging] = useState(false)
  const { plan: addPlan, check: addCheck, checking: addChecking } = useProvisionPlan(sourceClient, thread ? ownProjectOf(thread) : '', target?.missing ? target.machineId : null, addPath)
  useEffect(() => { setAddPath(null); setChanging(false) }, [target?.machineId])
  useEffect(() => { if (addPlan && addPath === null) setAddPath(defaultPath(addPlan)) }, [addPlan, addPath])
  const addReady = !target?.missing || (!!addPlan && !addPlan.blocked && !addChecking && pathAccepted(addCheck) && (addPath !== null || !addPlan.target.online))
  const provision = target?.missing ? { provision: { ...(addPath ? { path: addPath } : {}) } } : {}
  const addShown = addPlan && addPath ? displayPath(addPath, addPlan.target_home, addPlan.target.os) : null
  // The new thread starts a turn at once, so it needs an agent that can sign in there: the thread's own when it can, else one that is.
  const agents = useMachineAgents(target?.machineId)
  const [picked, setPicked] = useState<{ machine: string; kind: ProviderKind } | null>(null)
  const preferred = thread?.provider.kind
  const fallback = agents ? defaultAgent(agents, preferred) : null
  const agent = picked && picked.machine === target?.machineId ? picked.kind : fallback
  const warning = agents && target ? noAgentWarning(agents, target.machineName) : null
  const [anyway, setAnyway] = useState(false)
  const blocked = !!warning && !anyway && target?.online !== false
  // The model and effort come from that machine's catalog of the chosen agent: the source thread's when it has them,
  // else its default; a pick the user made stays while it still fits the machine and agent.
  const lists = useComposer((d) => (target ? d.remote[target.machineId] : undefined))
  useEffect(() => { if (target?.online) void loadMachineLists(target.machineId, false, target.projectId) }, [target?.machineId, target?.online, target?.projectId])
  const catalog = lists?.providers.find((item) => item.kind === agent)?.models ?? []
  const [modelPick, setModelPick] = useState<(KindedChoice & { machine: string }) | null>(null)
  const source = thread ? { kind: thread.provider.kind, model: thread.model ?? null, effort: thread.effort ?? null } : null
  const choice = targetModel(catalog, agent, source, modelPick?.machine === target?.machineId ? modelPick : null)
  const pickModel = (model: string | null, effort: string | null) => {
    if (target && agent) setModelPick({ machine: target.machineId, kind: agent, model, effort })
    return Promise.resolve(true)
  }
  const fork = async () => {
    if (!target || generated === null || blocked || !addReady) return
    setBusy(true); setError('')
    try {
      if (move) {
        const result = await callThread(threadId, 'threads.move_to_machine', { ...moveParams(threadId, target, state, generated, null, agent, choice), ...provision }, machineId)
        toast.success(moveQueuedText(result.target_name, target.online), { description: target.online ? 'This thread becomes read-only with a link once it arrives.' : 'It waits in the outbox; nothing is locked meanwhile.' })
      } else {
        const result = await callThread(threadId, 'threads.fork_to_machine', { ...forkParams(threadId, target, state, generated, null, agent, choice), ...provision }, machineId)
        toast.success(forkQueuedText(result.target_name, target.online), { description: target.online ? 'A notice in this thread links to the new one when it arrives.' : 'It waits in the outbox.' })
      }
      close()
    } catch (e) { setError(errorText(e)); setBusy(false) }
  }
  const dismiss = () => { if (!busy) close() }
  const signedOut = agents?.find((item) => item.kind === agent && item.available && item.signedIn === false)
  const installed = agents?.filter((item) => item.available) ?? []
  return <Dialog onClose={dismiss} width={560} testId={move ? 'move-sheet' : 'fork-sheet'}>
    <DialogHeader title={move ? 'Continue on another machine' : 'Fork to another machine'} description={move ? 'Moves the thread and its uncommitted work. This one becomes read-only.' : 'Starts a copy there with a hand-off note. Both threads keep going.'} onClose={dismiss} />
    <DialogBody footer scroll>
      {targets.length === 0
        ? <Hint>No other machine is in your network yet.</Hint>
        : <Field label="Machine"><div role="radiogroup" aria-label="Machine" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {targets.map((item) => <MachineChoice key={item.machineId} item={item} checked={target?.machineId === item.machineId} disabled={busy}
            detail={item.missing ? notYetDetail(item.machineName, target?.machineId === item.machineId ? addShown : null) : undefined} onSelect={() => setState({ ...state, machine: item.machineId })} />)}
        </div></Field>}
      {target?.missing && <div testId="fork-provision" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {addPlan?.blocked ? <ErrorText testId="fork-provision-blocked">{addPlan.blocked}</ErrorText> : changing && addPlan
          ? <Field label={`Folder on ${target.machineName}`}><FolderField testId="fork-provision-folder" plan={addPlan} path={addPath ?? ''} onPath={setAddPath} check={addCheck} checking={addChecking} disabled={busy} /></Field>
          : <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Hint>{addPlan ? `${target.machineName} gets the project first${addPlan.env_files.length ? `, with ${addPlan.env_files.length === 1 ? 'its env file' : `its ${addPlan.env_files.length} env files`}` : ''}; then the ${move ? 'thread moves' : 'fork starts'} there.` : `Asking ${target.machineName} where it keeps projects…`}</Hint>
            {addPlan && addPlan.target.online && <Button size="sm" variant="ghost" testId="fork-provision-change" disabled={busy} onClick={() => setChanging(true)}>Change folder…</Button>}
          </div>}
      </div>}
      {/* Only the agents installed there; a signed-out Claude, Codex or Cursor says so (omp, OpenCode and pi have no sign-in). */}
      {target && installed.length > 0 && <Field label="Agent"><div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
          <div role="radiogroup" aria-label="Agent" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, flexGrow: 1 }}>
            {installed.map((item) => <PickerChip key={item.kind} testId={`fork-agent-${item.kind}`} mark={item.kind} chevron={false} selected={agent === item.kind} secondary={item.signedIn === false ? 'Signed out' : undefined} disabled={busy} label={agentLine(item, target.machineName)} onClick={() => setPicked({ machine: target.machineId, kind: item.kind })}>{item.label}</PickerChip>)}
          </div>
          {agent && lists && catalog.length > 0 && <ModelChoice catalog={catalog} lists={lists} agent={agent} machineName={target.machineName} model={choice.model} effort={choice.effort} busy={busy} onPick={pickModel}
            onAgent={(kind, model, effort) => { setPicked({ machine: target.machineId, kind }); setModelPick({ machine: target.machineId, kind, model, effort }); return Promise.resolve(true) }}
            onReload={() => void loadMachineLists(target.machineId, true, target.projectId)} />}
        </div>
        {warning ? <ErrorText testId="fork-agent-warning">{warning}</ErrorText> : signedOut ? <Hint>{`Sign in to ${signedOut.label} on ${target.machineName} first, or its first turn fails.`}</Hint> : null}
        {warning && target.online && <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Checkbox testId="fork-agent-anyway" aria-label="Start anyway" checked={anyway} disabled={busy} onCheckedChange={setAnyway} />
          <Label color={t.text} size={14} lineHeight={22}>Start anyway; I will sign in there</Label>
        </div>}
      </div></Field>}
      {target && agents && installed.length === 0 && warning && <ErrorText testId="fork-agent-warning">{warning}</ErrorText>}
      {/* Holds the agent row's place while the machine answers, so the note below does not jump. */}
      {target?.online && agents === undefined && <Field label="Agent"><div style={{ display: 'flex', alignItems: 'center', height: 28 }}><Hint>{`Checking which agents ${target.machineName} has…`}</Hint></div></Field>}
      <Field label="Hand-off note">
        <TextArea ref={noteField} onFocus={() => { noteTouched.current = true }} key={generated === null ? 'writing' : 'written'} testId="fork-note" label="Hand-off note" value={generated === null ? '' : state.note} placeholder={generated === null ? 'Writing the hand-off note…' : 'What the other machine needs to pick this up'} disabled={generated === null || busy} minRows={6} maxRows={12} onChange={(note) => setState((current) => ({ ...current, note }))} />
        {noteError && <ErrorText testId="fork-note-error">{noteError}</ErrorText>}
      </Field>
      {!move && <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <Checkbox testId="fork-push-origin" aria-label="Also push to origin" checked={state.pushOrigin} disabled={busy} onCheckedChange={(pushOrigin) => setState((current) => ({ ...current, pushOrigin }))} style={{ marginTop: 3 }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 1, minWidth: 0 }}>
          <Label color={t.text} size={14} lineHeight={22}>Also push to origin</Label>
          <Hint>Off by default, because the repository may be public. The work reaches the other machine either way.</Hint>
        </div>
      </div>}
      {error && <ErrorText testId="fork-error">{error}</ErrorText>}
    </DialogBody>
    <DialogFooter>
      <Button size="lg" variant="secondary" disabled={busy} onClick={dismiss}>Cancel</Button>
      <Button size="lg" variant="primary" testId={move ? 'move-confirm' : 'fork-confirm'} busy={busy} disabled={!target || generated === null || blocked || !addReady} onClick={() => void fork()}>{target ? `${move ? 'Continue on' : 'Fork to'} ${target.machineName}` : move ? 'Continue there' : 'Fork'}</Button>
    </DialogFooter>
  </Dialog>
}

/** One machine as a half-width tile: its badge, its name, and what it can do (the agents there, or offline). */
function MachineChoice({ item, checked, disabled, onSelect, detail }: { item: ForkInstance; checked: boolean; disabled: boolean; onSelect: () => void; detail?: string }) {
  const t = useTheme()
  const c = useControls()
  const agents = useMachineAgents(item.online ? item.machineId : undefined)
  return (
    <div
      testId={`fork-machine-${item.machineId}`} role="radio" aria-checked={checked} aria-label={item.machineName} aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : 0}
      onClick={disabled ? undefined : onSelect}
      onKeyDown={(e) => { if (!disabled && (e.key === 'enter' || e.key === 'space')) onSelect() }}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, flexBasis: 0, flexGrow: 1, minWidth: 236, paddingTop: 8, paddingBottom: 8, paddingLeft: 10, paddingRight: 10, borderRadius: RADIUS.lg,
        borderWidth: 1, borderColor: checked ? c.focus : c.ink(0.08), backgroundColor: checked ? c.optionSelected : 'rgba(0, 0, 0, 0)', cursor: disabled ? 'default' : 'pointer',
        ...(disabled ? {} : { hover: { backgroundColor: checked ? c.optionSelected : c.ink(0.04) }, focusVisible: { outlineWidth: 2, outlineColor: c.focus, outlineOffset: 0 } }),
      }}
    >
      <div style={{ display: 'flex', opacity: item.online ? 1 : 0.55 }}><MachineBadge glyph={glyphOfMachine(item.machineId)} size={20} /></div>
      <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, flexShrink: 1, minWidth: 0, pointerEvents: 'none' }}>
        <Label color={t.text} size={14} lineHeight={20} weight={500} truncate>{item.machineName}</Label>
        <Label color={t.textSecondary} size={12} lineHeight={16} truncate>{detail ?? machineChoiceDetail(item.online, agents)}</Label>
      </div>
      <Radio checked={checked} disabled={disabled} />
    </div>
  )
}

/** The chosen agent's model and effort on the target machine, in the composer's picker. Its tabs are that machine's agents,
 *  so picking another agent's model there also moves the agent chip. It opens downward, over the sheet. */
function ModelChoice({ catalog, lists, agent, machineName, model, effort, busy, onPick, onAgent, onReload }: {
  catalog: ProviderModel[]; lists: RemoteLists; agent: ProviderKind; machineName: string; model: string | null; effort: string | null; busy: boolean
  onPick: (model: string | null, effort: string | null) => Promise<boolean>
  onAgent: (kind: ProviderKind, model: string | null, effort: string | null) => Promise<boolean>; onReload: () => void
}) {
  const current = model ? findModel(catalog, model) : catalog.find((item) => item.is_default)
  const traits = triggerTraits(current, model)
  return <div testId="fork-model" style={{ display: 'flex', minWidth: 0, flexShrink: 1 }}>
    <ModelPicker provider={{ kind: agent, instance: 'default' }} providers={lists.providers} machineName={machineName} model={model} effort={effort} accounts={lists.accounts}
      canPickModel canPickProvider canReload loading={lists.loading} busy={busy} side="bottom" priority={7}
      onModelChange={(next, nextEffort) => onPick(next || null, nextEffort ?? null)}
      onEffortChange={(next) => onPick(model, next)}
      onProviderChange={(next, picked) => onAgent(next.kind, picked?.model ?? null, picked?.effort ?? null)}
      onReload={onReload}
      label={() => <ModelTriggerLabel model={current?.display_name ?? model ?? ''} qualifier={modelQualifier(catalog, current)} fast={traits.fast} effort={effort ? formatEffort(effort) : null} traits={traits.labels} />} />
  </div>
}
