import { useEffect, useSyncExternalStore } from 'react'
import { failure, type Failure } from '../problems/Line.tsx'
import type { Settings } from '../../../../packages/kybern-client/src/types.ts'
import { changedSharedFields } from '../../../../packages/kybern-client/src/sharedState.ts'
import { getClient, useApp } from '../state.ts'
import { shareSettings } from './shared.ts'

let state: { settings: Settings | null; error: Failure | null; saving: boolean } = { settings: null, error: null, saving: false }
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const emit = (patch: Partial<typeof state>) => { state = { ...state, ...patch }; for (const listener of listeners) listener() }
let revision = 0
export const latestSettings = () => state.settings
export const latestError = () => state.error

/** The last document the daemon confirmed; the page shows it plus the writes still in flight. */
let confirmed: Settings | null = null
/** Writes waiting for the daemon, sent one after another. */
let inFlight = 0
let queue: Promise<void> = Promise.resolve()

/**
 * Optimistic and in order: the page shows the change at once and every control stays usable while it saves (a control
 * that went disabled mid-click lost focus, and the page moved). Each write sends the whole document as the page has it,
 * so changes made while an earlier one saves are included. A failure goes back to the last confirmed document and sets
 * `error`; Settings shows it as a problem toast.
 */
export function updateSettings(patch: Partial<Settings>): Promise<void> {
  const client = getClient()
  if (!client || !state.settings) return Promise.resolve()
  if (!inFlight) confirmed = state.settings
  inFlight++
  emit({ settings: { ...state.settings, ...patch }, saving: true, error: null })
  const write = queue.then(async () => {
    if (getClient() !== client) return
    const before = confirmed ?? state.settings!
    try {
      const saved = await client.call('settings.update', { settings: state.settings! })
      if (getClient() !== client) return
      revision++
      confirmed = saved
      // A later write already holds the newer document; the last one to land adopts the daemon's.
      if (inFlight === 1) emit({ settings: saved })
      // A shared field also goes to the other machines (a queued change waits for an offline one); per-machine fields stay here.
      void shareSettings(changedSharedFields(before, saved))
    } catch (error) {
      if (getClient() !== client) return
      emit({ settings: confirmed, error: failure('save the settings', error) })
    }
  }).finally(() => { inFlight--; if (getClient() === client && !inFlight) emit({ saving: false }) })
  queue = write
  return write
}

/** Adopt a settings document the daemon just returned (another surface changed it). */
export function setSettings(settings: Settings) { revision++; emit({ settings, error: null }) }

/** Read the daemon's settings again (a page whose values another surface may have changed, like "Always allow" on an approval). */
export async function refreshSettings() {
  const client = getClient()
  if (!client) return
  const at = revision
  try {
    const settings = await client.call('settings.get', {})
    if (getClient() === client && revision === at) emit({ settings, error: null })
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
      if (!live || !settings) return
      revision++
      // Our own write echoes back before it resolves; while writes are in flight the page keeps its newer document.
      if (inFlight) confirmed = settings
      else emit({ settings, error: null })
    })
    void client.call('settings.get', {}).then((settings) => {
      if (live && revision === at) emit({ settings, error: null })
    }, (error) => { if (live) emit({ error: failure('read the settings', error) }) })
    return () => { live = false; off() }
  }, [status])
}

