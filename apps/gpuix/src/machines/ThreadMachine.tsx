// Which machine an open thread runs on, said quietly where the user is looking: the title bar (badge and "on os-kdi") and the
// thread composer's footer (the same, read-only; a new chat has the picker instead). Nothing for a thread on the machine the user
// is at, and nothing with one machine. The sidebar's badge stays the glance; this is the sentence.
import { ink, Label, useTheme } from '../ui.tsx'
import { muted, Tip } from '../nav/overlay.tsx'
import { MachineBadge } from '../sidebar/MachineBadge.tsx'
import { glyphOfMachine, machineHub, useMachines } from './index.ts'

export function ThreadMachine({ machineId, size = 14, testId }: { machineId: string | undefined; size?: number; testId?: string }) {
  const t = useTheme()
  const machines = useMachines()
  const row = machineId && machines.length > 1 ? machines.find((machine) => machine.machineId === machineId) : undefined
  if (!machineId || !row || row.isLocal) return null
  const name = machineHub().set.displayName(machineId)
  return (
    <div testId={testId} aria-label={`Runs on ${name}`} style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 1, minWidth: 0, paddingLeft: 4, paddingRight: 4 }}>
      <MachineBadge glyph={glyphOfMachine(machineId)} size={size} />
      <Label color={muted(t, 0.72)} size={12} lineHeight={16} truncate style={{ pointerEvents: 'none' }}>{`on ${name}`}</Label>
    </div>
  )
}

/**
 * The title bar's machine: one compact pill (badge and name, the composer machine chip's pair) that sits with the title it
 * qualifies, inside the chat tab. Nothing for a thread on this machine or with one machine.
 */
export function MachinePill({ machineId, testId }: { machineId: string | undefined; testId?: string }) {
  const t = useTheme()
  const machines = useMachines()
  const row = machineId && machines.length > 1 ? machines.find((machine) => machine.machineId === machineId) : undefined
  if (!machineId || !row || row.isLocal) return null
  const name = machineHub().set.displayName(machineId)
  return (
    <Tip label={`Runs on ${name}`} side="bottom">
      <div testId={testId} aria-label={`Runs on ${name}`} style={{ display: 'flex', alignItems: 'center', gap: 5, height: 20, paddingLeft: 3, paddingRight: 7, borderRadius: 10, flexShrink: 0, backgroundColor: ink(t, 0.06) }}>
        <MachineBadge glyph={glyphOfMachine(machineId)} size={14} />
        <Label color={t.textSecondary} size={12} lineHeight={16} weight={500} style={{ pointerEvents: 'none', whiteSpace: 'nowrap' }}>{name}</Label>
      </div>
    </Tip>
  )
}
