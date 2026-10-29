// Which machine an open thread runs on, said quietly where the user is looking: the title bar (badge and "on os-kdi") and the
// thread composer's footer (the same, read-only; a new chat has the picker instead). Nothing for a thread on the machine the user
// is at, and nothing with one machine. The sidebar's badge stays the glance; this is the sentence.
import { Label, useTheme } from '../ui.tsx'
import { muted } from '../nav/overlay.tsx'
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
