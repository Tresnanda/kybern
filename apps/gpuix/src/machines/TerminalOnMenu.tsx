// "New terminal on…" (U4): one row per other machine that can open a shell now. Nothing renders with a single machine.
import { terminalMachines } from '../../../../packages/kybern-client/src/machineUtilities.ts'
import { errorText } from '../nav/actions.ts'
import { MenuSub, MenuItem } from '../nav/overlay.tsx'
import { DOCK_ICONS } from '../dock/icons.ts'
import { MachineBadge } from '../sidebar/MachineBadge.tsx'
import { useApp } from '../state.ts'
import { toast } from '../shell/toasts.tsx'
import { glyphOfMachine, machineHub, useMachines } from './index.ts'
import { openTerminalOn } from './utilities.ts'

export function TerminalOnMenu({ threadId, leaf }: { threadId: string; leaf?: string }) {
  const machines = useMachines()
  const own = useApp((s) => s.threads.find((thread) => thread.id === threadId)?.machineId) ?? machineHub().localMachineId
  const targets = terminalMachines(machines, own)
  if (!targets.length) return null
  return <MenuSub id="terminal-on" label="New terminal on…" icon={DOCK_ICONS.terminal} testId="terminal-on" width={216}>
    {targets.map((machine) => <MenuItem key={machine.machineId} id={`terminal-on-${machine.machineId}`} testId={`terminal-on-${machine.machineId}`} iconNode={<MachineBadge glyph={glyphOfMachine(machine.machineId)} size={16} />} label={machine.name}
      onSelect={() => void openTerminalOn(threadId, machine, leaf).catch((error) => toast.error(`Unable to open a terminal on ${machine.name}`, { description: errorText(error) }))} />)}
  </MenuSub>
}
