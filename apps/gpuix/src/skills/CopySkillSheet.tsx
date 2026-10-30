// "Copy <skill>…" (ADE-86): pick the machine that sends it, the machines it goes to and the harness folders it lands in, then
// see what happened on each. A machine with a different version is never preselected; choosing it turns the action into
// "Replace on <machine>" with a note that the old copy is kept there. Offline machines get it when they return (outbox).
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { OUTBOX_CHANGED_NOTIFICATION, SKILL_HOMES, type OutboxItem, type SkillHome, type SkillNetworkEntry, type SkillsCopyResult, type SkillsNetworkView } from '../../../../packages/kybern-client/src/types.ts'
import {
  copyButtonLabel, copyOutcomeText, copyRequest, copyTargets, defaultSource, readersText, SKILL_HOME_DETAILS, skippedOf, sourceHomes, sourcesOf, type CopyTargetModel,
} from '../../../../packages/kybern-client/src/skillSync.ts'
import { Dialog } from '../nav/overlay.tsx'
import { errorText } from '../nav/actions.ts'
import { Button } from '../kit/Button.tsx'
import { Card } from '../kit/Card.tsx'
import { Checkbox } from '../kit/Checkbox.tsx'
import { PickerChip } from '../kit/PickerChip.tsx'
import { RADIUS, useControls } from '../kit/controls.ts'
import { toneColor } from '../kit/tone.ts'
import { MachineBadge } from '../sidebar/MachineBadge.tsx'
import { glyphOfMachine } from '../machines/index.ts'
import { DialogBody, DialogFooter, DialogHeader, ErrorText, Field, Hint } from '../environments/kit.tsx'
import { Label, useTheme } from '../ui.tsx'
import { FONT_MONO } from '../theme.ts'
import { copySkill, skillsClient } from './store.ts'

/** `inline` draws the sheet in the window instead of a popup layer (native fixtures, whose captures leave popups out). */
export function CopySkillSheet({ view, entry, close, inline = false }: { view: SkillsNetworkView; entry: SkillNetworkEntry; close: () => void; inline?: boolean }) {
  const t = useTheme()
  const c = useControls()
  const Frame = inline
    ? ({ children, testId }: { children: ReactNode; testId?: string; onClose: () => void; width: number }) => <div testId={testId} style={{ display: 'flex', flexDirection: 'column', width: 560, alignSelf: 'center', borderRadius: 16, borderWidth: 1, borderColor: c.ink(0.1), backgroundColor: t.v('--popover') }}>{children}</div>
    : Dialog
  const sources = sourcesOf(view, entry)
  const [sourceId, setSourceId] = useState(() => defaultSource(view, entry)?.id ?? null)
  const source = sources.find((machine) => machine.id === sourceId) ?? null
  const targets = useMemo(() => (source ? copyTargets(view, entry, source.id) : []), [view, entry, source?.id])
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const chosen = picked ?? new Set(targets.filter((target) => target.preselected).map((target) => target.machine.id))
  const [homes, setHomes] = useState<SkillHome[] | null>(null)
  const origin = source ? sourceHomes(entry, source.id) : []
  const folders = homes ?? origin
  // A new source proposes its own targets and folders.
  useEffect(() => { setPicked(null); setHomes(null) }, [source?.id])
  const selected = targets.filter((target) => chosen.has(target.machine.id))
  const replacing = selected.filter((target) => target.state === 'different')
  const extra = folders.filter((home) => !origin.includes(home))
  const skipped = source ? skippedOf(entry, source.id) : []
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<SkillsCopyResult | null>(null)
  const title = entry.display_name || entry.name
  const dismiss = () => { if (!busy) close() }
  const ready = !!source && folders.length > 0 && (selected.length > 0 || extra.length > 0)
  const toggle = (id: string, on: boolean) => { const next = new Set(chosen); if (on) next.add(id); else next.delete(id); setPicked(next) }

  const copy = async () => {
    if (!ready || !source) return
    setBusy(true); setError('')
    try {
      const request = copyRequest(entry, source, selected, folders, replacing.length > 0)
      // Folders the source lacks are added on the source too, at once.
      if (extra.length) request.to.push({ machine: source.id, homes: folders })
      setResult(await copySkill(request))
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  if (result) return <Frame onClose={close} width={560} testId="skill-copy-sheet">
    <DialogHeader title={`Copying ${title}`} description={result.targets.some((target) => target.state === 'queued') ? 'You can close this. A machine that is offline gets it when it returns.' : 'Nothing else changed on any machine.'} onClose={close} />
    <DialogBody footer>
      <div testId="skill-copy-result" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {result.targets.map((target) => <OutcomeRow key={target.machine_id} outcome={target} />)}
      </div>
      {(result.skipped?.length ?? 0) > 0 && <Hint>{`Left out: ${result.skipped!.join(', ')}`}</Hint>}
    </DialogBody>
    <DialogFooter><Button size="lg" variant="primary" testId="skill-copy-done" onClick={close}>Done</Button></DialogFooter>
  </Frame>

  return <Frame onClose={dismiss} width={560} testId="skill-copy-sheet">
    <DialogHeader title={`Copy ${title}`} description={entry.description || 'Choose where it goes. Nothing is copied until you do.'} onClose={dismiss} />
    <DialogBody footer scroll>
      {!source ? <Hint>No machine that has this skill is online to send it.</Hint> : <>
        {sources.length > 1 && <Field label="From"><div role="radiogroup" aria-label="From" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {sources.map((machine) => <PickerChip key={machine.id} testId={`skill-from-${machine.id}`} chevron={false} selected={machine.id === source.id} disabled={busy} label={`From ${machine.name}`} onClick={() => setSourceId(machine.id)}>{machine.is_self ? `${machine.name} (this computer)` : machine.name}</PickerChip>)}
        </div></Field>}
        {targets.length > 0 && <Field label="To"><div aria-label="To" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {targets.map((target) => <TargetTile key={target.machine.id} target={target} checked={chosen.has(target.machine.id)} disabled={busy || !target.selectable} onToggle={(on) => toggle(target.machine.id, on)} />)}
        </div></Field>}
        <Field label="Folders">
          <FolderList selected={folders} origin={origin} disabled={busy} onChange={setHomes} />
          <Label color={t.textSecondary} size={12.5} lineHeight={18}>{extra.length ? `Also adds it to ${extra.map((home) => SKILL_HOME_DETAILS[home].path).join(' and ')} on ${source.name}.` : `The folders it’s in on ${source.name}. Add ~/.agents/skills to make it available to most agents.`}</Label>
        </Field>
        {replacing.length > 0 && <Card tone="warning" testId="skill-copy-replace">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <div style={{ width: 6, height: 6, borderRadius: 3, marginTop: 7, flexShrink: 0, backgroundColor: toneColor(t, 'warning') }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 1, minWidth: 0 }}>
              <Label color={t.text} size={13} lineHeight={19} weight={500}>{`Replaces the version on ${replacing.map((target) => target.machine.name).join(' and ')}`}</Label>
              <Label color={t.textSecondary} size={13} lineHeight={19}>The copy there moves to Kybern’s data folder on that machine, so you can get it back.</Label>
            </div>
          </div>
        </Card>}
        {skipped.length > 0 && <Hint>{`Left out of the copy: ${skipped.join(', ')}`}</Hint>}
        {error && <ErrorText testId="skill-copy-error">{error}</ErrorText>}
      </>}
    </DialogBody>
    <DialogFooter>
      <Button size="lg" variant="secondary" disabled={busy} onClick={dismiss}>Cancel</Button>
      <Button size="lg" variant={replacing.length ? 'destructive' : 'primary'} testId="skill-copy-confirm" busy={busy} disabled={!ready} onClick={() => void copy()}>{selected.length ? copyButtonLabel(selected, replacing.length > 0) : source ? `Copy on ${source.name}` : 'Copy'}</Button>
    </DialogFooter>
  </Frame>
}

/** A machine as a half-width tile, like the fork and provisioning sheets': badge, name, what it holds, and a box. */
function TargetTile({ target, checked, disabled, onToggle }: { target: CopyTargetModel; checked: boolean; disabled: boolean; onToggle: (on: boolean) => void }) {
  const t = useTheme()
  const c = useControls()
  const live = target.state !== 'offline' && target.selectable
  const tone = target.state === 'different' ? toneColor(t, 'warning') : t.textSecondary
  return <div
    testId={`skill-to-${target.machine.id}`} role="checkbox" aria-checked={checked} aria-label={target.machine.name} aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : 0}
    onClick={disabled ? undefined : () => onToggle(!checked)}
    onKeyDown={(e) => { if (!disabled && (e.key === 'enter' || e.key === 'space')) onToggle(!checked) }}
    style={{
      display: 'flex', alignItems: 'center', gap: 10, flexBasis: 0, flexGrow: 1, minWidth: 236, paddingTop: 8, paddingBottom: 8, paddingLeft: 10, paddingRight: 10, borderRadius: RADIUS.lg,
      borderWidth: 1, borderColor: checked ? c.focus : c.ink(0.08), backgroundColor: checked ? c.optionSelected : 'rgba(0, 0, 0, 0)', cursor: disabled ? 'default' : 'pointer', opacity: target.selectable ? 1 : 0.6,
      ...(disabled ? {} : { hover: { backgroundColor: checked ? c.optionSelected : c.ink(0.04) }, focusVisible: { outlineWidth: 2, outlineColor: c.focus, outlineOffset: 0 } }),
    }}
  >
    <div style={{ display: 'flex', opacity: live ? 1 : 0.55 }}><MachineBadge glyph={glyphOfMachine(target.machine.id)} size={20} /></div>
    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, flexShrink: 1, minWidth: 0, pointerEvents: 'none' }}>
      <Label color={t.text} size={14} lineHeight={20} weight={500} truncate>{target.machine.name}</Label>
      <Label color={tone} size={12} lineHeight={16} truncate>{target.detail}</Label>
    </div>
    {target.selectable && <div style={{ display: 'flex', pointerEvents: 'none' }}><Checkbox checked={checked} disabled={disabled} aria-label={target.machine.name} /></div>}
  </div>
}

/** The seven harness folders with a box each: the path, who reads it. */
function FolderList({ selected, origin, disabled, onChange }: { selected: readonly SkillHome[]; origin: readonly SkillHome[]; disabled: boolean; onChange: (homes: SkillHome[]) => void }) {
  const t = useTheme()
  const c = useControls()
  const toggle = (home: SkillHome, on: boolean) => onChange(SKILL_HOMES.filter((item) => (item === home ? on : selected.includes(item))))
  return <div testId="skill-copy-folders" style={{ display: 'flex', flexDirection: 'column', borderWidth: 1, borderColor: c.ink(0.08), borderRadius: RADIUS.lg, paddingTop: 2, paddingBottom: 2 }}>
    {SKILL_HOMES.map((home) => {
      const on = selected.includes(home)
      const detail = SKILL_HOME_DETAILS[home]
      return <div key={home} onClick={disabled ? undefined : () => toggle(home, !on)} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 34, paddingLeft: 10, paddingRight: 12, cursor: disabled ? 'default' : 'pointer' }}>
        <Checkbox testId={`skill-home-${home}`} aria-label={detail.path} checked={on} disabled={disabled} onCheckedChange={(next) => toggle(home, next)} />
        <Label color={t.text} size={13} lineHeight={18} font={FONT_MONO} style={{ flexShrink: 0 }}>{detail.path}</Label>
        <Label color={t.textTertiary} size={12} lineHeight={16} truncate style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}>{readersText(home)}</Label>
        {origin.includes(home) && <Label color={t.textTertiary} size={12} lineHeight={16} style={{ flexShrink: 0 }}>Has it</Label>}
      </div>
    })}
  </div>
}

/** A target after the copy: queued items follow the outbox when this machine holds them. */
function OutcomeRow({ outcome }: { outcome: SkillsCopyResult['targets'][number] }) {
  const t = useTheme()
  const [item, setItem] = useState<OutboxItem | null>(null)
  useEffect(() => {
    const client = skillsClient()
    if (!client || !outcome.outbox_id) return
    return client.onNotification(OUTBOX_CHANGED_NOTIFICATION, (params) => { const next = params as OutboxItem; if (next.id === outcome.outbox_id) setItem(next) })
  }, [outcome.outbox_id])
  const failed = outcome.state === 'failed' || outcome.state === 'unsupported' || item?.state === 'failed' || item?.state === 'expired'
  const text = item?.state === 'delivered' ? 'Copied' : item && failed ? item.last_error ?? 'Not copied' : copyOutcomeText(outcome)
  const tone = failed ? t.red : item?.state === 'delivered' || outcome.state === 'done' ? t.green : t.textTertiary
  return <div testId={`skill-outcome-${outcome.machine_id}`} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
    <MachineBadge glyph={glyphOfMachine(outcome.machine_id)} size={20} />
    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
      <Label color={t.text} size={14} lineHeight={20} weight={500} truncate>{outcome.name}</Label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ width: 6, height: 6, borderRadius: 3, flexShrink: 0, backgroundColor: tone }} />
        <Label color={failed ? t.red : t.textSecondary} size={12.5} lineHeight={18}>{text}</Label>
      </div>
    </div>
  </div>
}
