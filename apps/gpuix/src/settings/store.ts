import { useEffect, useSyncExternalStore } from 'react'
import type { Settings } from '../../../../packages/kybern-client/src/types.ts'
import { getClient, useApp } from '../state.ts'

let state: { settings: Settings | null; error: string; saving: boolean } = { settings: null, error: '', saving: false }
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const emit = (patch: Partial<typeof state>) => { state = { ...state, ...patch }; for (const listener of listeners) listener() }
let revision = 0
export const latestSettings = () => state.settings

/** One in-flight write: controls disable until the daemon confirms the full document. */
export async function updateSettings(patch: Partial<Settings>) {
  const client = getClient()
  if (!client || !state.settings || state.saving) return
  emit({ saving: true, error: '' })
  try {
    const saved = await client.call('settings.update', { settings: { ...state.settings, ...patch } })
    revision++
    emit({ settings: saved })
  } catch (error) {
    emit({ error: `Unable to save settings. Check the connection and try again. ${String(error)}` })
  } finally { emit({ saving: false }) }
}

export function useSettings() { return useSyncExternalStore(subscribe, () => state) }

/** Mounted only with Settings. Subscribe before the read, so late hydration cannot overwrite events. */
export function useSettingsConnection() {
  const status = useApp((s) => s.status)
  useEffect(() => {
    const client = getClient()
    if (!client || status !== 'open') return
    let live = true
    const at = revision
    const off = client.onNotification('settings.changed', (params) => {
      const settings = (params as { settings?: Settings })?.settings
      if (live && settings) { revision++; emit({ settings, error: '' }) }
    })
    void client.call('settings.get', {}).then((settings) => {
      if (live && revision === at) emit({ settings, error: '' })
    }, (error) => { if (live) emit({ error: `Unable to read settings. Reconnect and try again. ${String(error)}` }) })
    return () => { live = false; off() }
  }, [status])
}
