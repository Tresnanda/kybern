import { useSyncExternalStore } from 'react'
import { addRecent, parseRecents, removeRecent, serializeRecents, type PreviewRecent } from '../../../../packages/kybern-client/src/previewRecents.ts'
import { getState } from '../state.ts'
import { activeEnvironment } from '../shell/environment.ts'
import { load, save } from '../shell/persist.ts'
const cache = new Map<string, readonly PreviewRecent[]>(), listeners = new Set<() => void>()
export function recentsKeyForThread(id: string) { return `kybern.preview.recents.${activeEnvironment().id}.${getState().threads.find(t => t.id === id)?.project_id ?? 'free'}` }
function read(key: string) {
  if (!cache.has(key)) cache.set(key, parseRecents(load<string | null>(key, null)))
  return cache.get(key)!
}
function write(key: string, list: PreviewRecent[]) { cache.set(key, list); save(key, serializeRecents(list)); listeners.forEach(l => l()) }
export function recordRecent(key: string, entry: PreviewRecent) { write(key, addRecent(read(key), entry)) }
export function forgetRecent(key: string, entry: PreviewRecent) { write(key, removeRecent(read(key), entry.kind, entry.value)) }
export function useRecents(key: string) { return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l) } }, () => read(key)) }
