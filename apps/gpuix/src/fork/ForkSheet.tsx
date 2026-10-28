// "Fork to another machine…" (design §7.1): pick a machine that has the project, read and edit the hand-off note, and
// fork. The daemon snapshots the work to a branch, sends it to the machine and starts a thread there; the source thread
// gets a notice when it arrives (`transcript/rows.tsx`). Both threads stay live. An offline machine receives the fork
// when it is back, through the outbox.
import { useEffect, useMemo, useState } from 'react'
import { forkParams, forkQueuedText, forkSheetDefaults, type ForkInstance } from '../../../../packages/kybern-client/src/forkMachine.ts'
import { Dialog } from '../nav/overlay.tsx'
import { errorText } from '../nav/actions.ts'
import { callThread, useApp } from '../state.ts'
import { toast } from '../shell/toasts.tsx'
import { Button } from '../kit/Button.tsx'
import { Checkbox } from '../kit/Checkbox.tsx'
import { RadioRow } from '../kit/RadioRow.tsx'
import { TextArea } from '../kit/TextArea.tsx'
import { DialogBody, DialogFooter, DialogHeader, ErrorText, Field, Hint } from '../environments/kit.tsx'
import { Label, useTheme } from '../ui.tsx'
import { forkTargetsOf } from './targets.ts'

export function ForkSheet({ threadId, machineId, close }: { threadId: string; machineId?: string; close: () => void }) {
  const t = useTheme()
  const thread = useApp((s) => s.threads.find((item) => item.id === threadId && item.machineId === machineId))
  const targets = useMemo<ForkInstance[]>(() => (thread ? forkTargetsOf(thread) : []), [thread])
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
  const target = targets.find((item) => item.machineId === state.machine) ?? targets[0]
  const fork = async () => {
    if (!target || generated === null) return
    setBusy(true); setError('')
    try {
      const result = await callThread(threadId, 'threads.fork_to_machine', forkParams(threadId, target, state, generated), machineId)
      toast.success(forkQueuedText(result.target_name, target.online), { description: target.online ? 'A notice in this thread links to the new one when it arrives.' : 'It waits in the outbox.' })
      close()
    } catch (e) { setError(errorText(e)); setBusy(false) }
  }
  const dismiss = () => { if (!busy) close() }
  return <Dialog onClose={dismiss} width={560} testId="fork-sheet">
    <DialogHeader title="Fork to another machine" description="Starts a copy of this thread on another machine with a hand-off note. Both threads keep going." onClose={dismiss} />
    <DialogBody footer scroll>
      {targets.length === 0
        ? <Hint>No other machine has this project yet.</Hint>
        : <Field label="Machine"><div role="radiogroup" aria-label="Machine" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {targets.map((item) => <RadioRow key={item.machineId} testId={`fork-machine-${item.machineId}`} checked={target?.machineId === item.machineId} title={item.machineName} description={item.online ? undefined : 'Offline. The fork waits until it is back.'} disabled={busy} onSelect={() => setState({ ...state, machine: item.machineId })} />)}
        </div></Field>}
      <Field label="Hand-off note">
        <TextArea testId="fork-note" label="Hand-off note" value={generated === null ? '' : state.note} placeholder={generated === null ? 'Writing the hand-off note…' : 'What the other machine needs to pick this up'} disabled={generated === null || busy} minRows={8} maxRows={14} onChange={(note) => setState((current) => ({ ...current, note }))} />
        {noteError ? <ErrorText testId="fork-note-error">{noteError}</ErrorText> : <Hint>The new thread starts with this note and a link back to this one. Edit it before you fork.</Hint>}
      </Field>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <Checkbox testId="fork-push-origin" aria-label="Also push to origin" checked={state.pushOrigin} disabled={busy} onCheckedChange={(pushOrigin) => setState((current) => ({ ...current, pushOrigin }))} style={{ marginTop: 3 }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 1, minWidth: 0 }}>
          <Label color={t.text} size={14} lineHeight={22}>Also push to origin</Label>
          <Hint>The work travels to the other machine either way. Pushing to the shared remote too is off by default, because the repository may be public.</Hint>
        </div>
      </div>
      {error && <ErrorText testId="fork-error">{error}</ErrorText>}
    </DialogBody>
    <DialogFooter>
      <Button size="lg" variant="secondary" disabled={busy} onClick={dismiss}>Cancel</Button>
      <Button size="lg" variant="primary" testId="fork-confirm" busy={busy} disabled={!target || generated === null} onClick={() => void fork()}>Fork</Button>
    </DialogFooter>
  </Dialog>
}
