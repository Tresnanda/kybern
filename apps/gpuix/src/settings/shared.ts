// Shared settings across machines (design §9.1). A shared field changed on one machine is sent to the others with
// `settings.share`; `settings.network_view` says where machines disagree ("Mixed") and which changes still wait for a
// machine. The view is read while a settings page shows it, and only with more than one machine.
import { useEffect, useSyncExternalStore } from 'react'
import { OUTBOX_CHANGED_NOTIFICATION, NETWORK_MACHINE_CHANGED_NOTIFICATION, type SettingsNetworkView, type SettingsShareResult } from '../../../../packages/kybern-client/src/types.ts'
import { getClient } from '../state.ts'
import { machineHub } from '../machines/index.ts'

interface SharedState { view: SettingsNetworkView | null }
let state: SharedState = { view: null }
const listeners = new Set<() => void>()
const emit = (patch: Partial<SharedState>) => { state = { ...state, ...patch }; for (const listener of listeners) listener() }
export const getSharedView = () => state.view
/** Tests: forget the view. */
export function resetSharedView() { state = { view: null }; reading = false; again = false }

let reading = false
let again = false
/** Read `settings.network_view` from the machine the user is at. Reads that arrive during a read fold into one rerun. */
export async function refreshSharedView(): Promise<void> {
  const client = getClient()
  if (!client || client.status !== 'open') return
  if (machineHub().machineCount <= 1) { if (state.view) emit({ view: null }); return }
  if (reading) { again = true; return }
  reading = true
  try {
    do {
      again = false
      try {
        const view = await client.call('settings.network_view', {})
        if (getClient() !== client) return
        emit({ view })
      } catch {
        // An older daemon, or an unreachable one: no Mixed markers, the settings still work.
        if (getClient() === client) emit({ view: null })
      }
    } while (again)
  } finally { reading = false }
}

/** Send changed shared fields to the other machines. It never throws: the edit already applied here. */
export async function shareSettings(fields: Record<string, unknown>): Promise<SettingsShareResult | null> {
  const client = getClient()
  if (!client || machineHub().machineCount <= 1 || Object.keys(fields).length === 0) return null
  try {
    const result = await client.call('settings.share', { fields })
    void refreshSharedView()
    return result
  } catch { return null }
}

/** The view while a surface shows it: re-read when settings, the outbox or a machine changes. `null` with one machine. */
export function useSharedView(): SettingsNetworkView | null {
  const view = useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn) } }, () => state.view)
  useEffect(() => {
    const client = getClient()
    void refreshSharedView()
    if (!client) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const soon = () => { clearTimeout(timer); timer = setTimeout(() => void refreshSharedView(), 250) }
    const stops = [client.onNotification('settings.changed', soon), client.onNotification(OUTBOX_CHANGED_NOTIFICATION, soon), client.onNotification(NETWORK_MACHINE_CHANGED_NOTIFICATION, soon)]
    const off = machineHub().onMachinesChanged(soon)
    return () => { clearTimeout(timer); off(); for (const stop of stops) stop() }
  }, [])
  return view
}
