// The "Mixed" marker beside a shared setting (design §9.1). When the machines that answered disagree about a field, a
// small chip opens a popover with each machine's value and "Use <value> on all machines". A change that still waits for
// an offline machine reads "Waiting for satyamas". Nothing shows with one machine, or for a field the machines agree on.
import { describeSharedValue, fieldOf, machineValues, pendingMachineNames, silentReason, useOnAllLabel, useOnAllMachines, valueGroups } from '../../../../packages/kybern-client/src/sharedState.ts'
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '../nav/overlay.tsx'
import { errorText } from '../nav/actions.ts'
import { toast } from '../shell/toasts.tsx'
import { PERMISSION_LABEL, PROVIDER_LABEL } from '../shared/lib/format.ts'
import { Label, useTheme } from '../ui.tsx'
import { refreshSettings } from './store.ts'
import { refreshSharedView, shareSettings, useSharedView } from './shared.ts'

/** Words for the choices a shared field can hold. */
const LABELS: Record<string, string> = { ...PERMISSION_LABEL, ...PROVIDER_LABEL }

export function SharedMark({ path }: { path: string }) {
  const t = useTheme()
  const view = useSharedView()
  const field = view ? fieldOf(view, path) : undefined
  if (!view || !field) return null
  const waiting = pendingMachineNames(view, path)
  if (!field.mixed && waiting.length === 0) return null
  const use = async (value: unknown) => {
    try {
      const result = await shareSettings(useOnAllMachines(path, value).fields)
      if (!result) throw new Error('Check the connection and try again.')
      await refreshSettings()
      await refreshSharedView()
    } catch (e) { toast.error('Unable to change the other machines', { description: errorText(e) }) }
  }
  return <div testId={`shared-${path}`} style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
    {waiting.length > 0 && <Label color={t.textSecondary} size={13} lineHeight={20}>{`Waiting for ${waiting.join(', ')}`}</Label>}
    {field.mixed && <Menu testId={`mixed-${path}`} align="end" width={304} trigger={() =>
      <div role="button" tabIndex={0} aria-label={`${path.replaceAll('_', ' ')} differs between machines`} style={{ display: 'flex', alignItems: 'center', height: 22, paddingLeft: 9, paddingRight: 9, borderRadius: 11, cursor: 'pointer', backgroundColor: t.v('--color-background-elevated-secondary') }}>
        <Label color={t.text} size={12} lineHeight={16} weight={500}>Mixed</Label>
      </div>}>
      <MenuLabel>On each machine</MenuLabel>
      {machineValues(view, path).map((entry) => <MenuItem key={entry.machine.id} id={`machine-${entry.machine.id}`} label={entry.machine.is_self ? `${entry.machine.name} (this computer)` : entry.machine.name}
        detail={entry.known ? describeSharedValue(path, entry.value, LABELS) : (silentReason(entry.machine) ? 'No answer' : 'Not set')} disabled keepOpen onSelect={() => {}} />)}
      <MenuSeparator />
      {valueGroups(view, path).map((group, index) => <MenuItem key={index} id={`use-${index}`} testId={`use-on-all-${path}-${index}`} label={useOnAllLabel(path, group.value, LABELS)} onSelect={() => void use(group.value)} />)}
    </Menu>}
  </div>
}
