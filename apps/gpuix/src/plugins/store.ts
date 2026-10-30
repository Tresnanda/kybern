// The plugins on every machine (ADE-86): `plugins.network_view` read from the machine the user is at, which asks the other
// members. Read while Settings → Plugins shows it, and again when the outbox or a machine changes. Copies go to the same
// daemon (`plugins.copy`), which forwards one to the machine that sends the skill.
import { useEffect, useSyncExternalStore } from 'react'
import type { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { NETWORK_MACHINE_CHANGED_NOTIFICATION, OUTBOX_CHANGED_NOTIFICATION, type PluginsCopyParams, type PluginsCopyResult, type PluginsNetworkView } from '../../../../packages/kybern-client/src/types.ts'
import { errorText } from '../nav/actions.ts'
import { getClient } from '../state.ts'

interface PluginsState { view: PluginsNetworkView | null; error: string; loading: boolean }
let state: PluginsState = { view: null, error: '', loading: false }
const listeners = new Set<() => void>()
const emit = (patch: Partial<PluginsState>) => { state = { ...state, ...patch }; for (const listener of listeners) listener() }

/** Native fixtures only (`plugins.fixture.tsx`): one in-memory client instead of the app's connection. */
let fixture: (() => KybernClient) | null = null
export function setPluginsFixture(next: typeof fixture) { fixture = next }
export const pluginsClient = (): KybernClient | null => fixture?.() ?? getClient()

let reading = false
let again = false
export async function refreshPlugins(): Promise<void> {
  const client = pluginsClient()
  if (!client || (!fixture && client.status !== 'open')) return
  if (reading) { again = true; return }
  reading = true
  if (!state.view) emit({ loading: true })
  try {
    do {
      again = false
      try {
        const view = await client.call('plugins.network_view', {})
        if (pluginsClient() !== client) return
        emit({ view, error: '', loading: false })
      } catch (e) {
        if (pluginsClient() === client) emit({ error: `Unable to read your plugins. ${errorText(e)}`, loading: false })
      }
    } while (again)
  } finally { reading = false }
}

export async function copyPlugin(params: PluginsCopyParams): Promise<PluginsCopyResult> {
  const client = pluginsClient()
  if (!client) throw new Error('Kybern is not connected. Check the connection and try again.')
  const result = await client.call('plugins.copy', params)
  void refreshPlugins()
  return result
}

export function usePluginsView(): PluginsState {
  const current = useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn) } }, () => state)
  useEffect(() => {
    const client = pluginsClient()
    void refreshPlugins()
    if (!client) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const soon = () => { clearTimeout(timer); timer = setTimeout(() => void refreshPlugins(), 400) }
    const stops = [client.onNotification(OUTBOX_CHANGED_NOTIFICATION, soon), client.onNotification(NETWORK_MACHINE_CHANGED_NOTIFICATION, soon)]
    return () => { clearTimeout(timer); for (const stop of stops) stop() }
  }, [])
  return current
}
