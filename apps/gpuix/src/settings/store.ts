import { useEffect, useSyncExternalStore } from 'react'
import type { Settings } from '../../../../packages/kybern-client/src/types.ts'
import { changedSharedFields } from '../../../../packages/kybern-client/src/sharedState.ts'
import { getClient, useApp } from '../state.ts'
import { shareSettings } from './shared.ts'

let state: { settings: Settings | null; error: string; saving: boolean } = { settings: null, error: '', saving: false }
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const emit = (patch: Partial<typeof state>) => { state = { ...state, ...patch }; for (const listener of listeners) listener() }
let revision = 0
export const latestSettings = () => state.settings
export const latestError = () => state.error

/** One in-flight write: controls disable until the daemon confirms the full document. */
export async function updateSettings(patch: Partial<Settings>) {
  const client = getClient()
  if (!client || !state.settings || state.saving) return
  emit({ saving: true, error: '' })
  try {
    const before = state.settings
    const saved = await client.call('settings.update', { settings: { ...before, ...patch } })
    if (getClient() !== client) return
    revision++
    emit({ settings: saved })
    // A shared field also goes to the other machines (a queued change waits for an offline one); per-machine fields stay here.
    void shareSettings(changedSharedFields(before, saved))
  } catch (error) {
    if (getClient() !== client) return
    emit({ error: `Unable to save settings. Check the connection and try again. ${String(error)}` })
  } finally { if (getClient() === client) emit({ saving: false }) }
}

/** Adopt a settings document the daemon just returned (another surface changed it). */
export function setSettings(settings: Settings) { revision++; emit({ settings, error: '' }) }

/** Read the daemon's settings again (a page whose values another surface may have changed, like "Always allow" on an approval). */
export async function refreshSettings() {
  const client = getClient()
  if (!client) return
  const at = revision
  try {
    const settings = await client.call('settings.get', {})
    if (getClient() === client && revision === at) emit({ settings, error: '' })
  } catch { /* the page keeps what it has */ }
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

