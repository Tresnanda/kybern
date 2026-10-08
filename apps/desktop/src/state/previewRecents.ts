// Recent previews, per environment and project, in localStorage. A per-viewer
// convenience: every read and write is guarded and an empty list renders fine.

import { useSyncExternalStore } from "react"

import {
  addRecent,
  parseRecents,
  removeRecent,
  serializeRecents,
  type PreviewRecent,
  type PreviewRecentKind,
} from "../../../../packages/kybern-client/src/previewRecents"
import { useStore } from "./store"

const EMPTY: readonly PreviewRecent[] = []
const cache = new Map<string, readonly PreviewRecent[]>()
const listeners = new Set<() => void>()

export function previewRecentsKey(environmentId: string, projectId: string | undefined): string {
  return `kybern.preview.recents.${environmentId}.${projectId ?? "free"}`
}

function read(key: string): readonly PreviewRecent[] {
  const cached = cache.get(key)
  if (cached) return cached
  let json: string | null = null
  try { json = localStorage.getItem(key) } catch { /* storage can be blocked */ }
  const list = parseRecents(json)
  const value = list.length > 0 ? list : EMPTY
  cache.set(key, value)
  return value
}

function write(key: string, list: PreviewRecent[]): void {
  cache.set(key, list.length > 0 ? list : EMPTY)
  try { localStorage.setItem(key, serializeRecents(list)) } catch { /* not persisted; still shown this session */ }
  listeners.forEach((listener) => listener())
}

export function recordRecent(key: string, entry: PreviewRecent): void {
  write(key, addRecent(read(key), entry))
}

export function forgetRecent(key: string, kind: PreviewRecentKind, value: string): void {
  write(key, removeRecent(read(key), kind, value))
}

/** The recents key for a thread's project in the active environment. */
export function recentsKeyForThread(threadId: string): string {
  const state = useStore.getState()
  return previewRecentsKey(state.environmentId, state.threads[threadId]?.project_id)
}

export function useRecents(key: string): readonly PreviewRecent[] {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    () => read(key),
    () => EMPTY,
  )
}
