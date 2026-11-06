// What makes a thread open instantly (#248), kept apart from `state.ts` so it has no app imports: which daemons
// answer `as_of_seq` / `gap_snapshot` / list cursors, first pages fetched ahead of a click (prefetch), the cursor each
// cached copy reflects, and the delayed "Syncing" state a pane shows while it has nothing to draw.
import { useSyncExternalStore } from 'react'
import type { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { createSyncIndicator, type SyncIndicator } from '../../../../packages/kybern-client/src/syncIndicator.ts'
import type { ThreadState } from '../../../../packages/kybern-client/src/transcript.ts'

// ---- daemon capabilities, learned from answers ----

const capable = new WeakMap<KybernClient, boolean>()
/** true: the daemon answers `as_of_seq`, `gap_snapshot` and list cursors; false: it does not; undefined: unknown yet. */
export const isCapable = (client: KybernClient): boolean | undefined => capable.get(client)
export function learnCapable(client: KybernClient, value: boolean) { capable.set(client, value) }

// ---- copies a click can draw at once ----

export interface WarmCopy { lastSeq: number; data: ThreadState }
/** First pages fetched ahead of a click, most recent last. Taken (not copied) by the open that uses one. */
const prefetched = new Map<string, WarmCopy>()
export const PREFETCHED_MAX = 8
export function putPrefetched(key: string, copy: WarmCopy) {
  prefetched.delete(key)
  prefetched.set(key, copy)
  while (prefetched.size > PREFETCHED_MAX) prefetched.delete(prefetched.keys().next().value!)
}
export function takePrefetched(key: string): WarmCopy | undefined {
  const copy = prefetched.get(key)
  prefetched.delete(key)
  return copy
}
export const prefetchedCount = () => prefetched.size

/** The cursor each thread's cached copy (disk or prefetch) reflects, so prefetch skips threads that are current. */
const cachedSeq = new Map<string, number>()
export const cachedSeqOf = (key: string) => cachedSeq.get(key)
export function noteCachedSeq(key: string, seq: number) {
  cachedSeq.set(key, seq)
  if (cachedSeq.size > 512) cachedSeq.delete(cachedSeq.keys().next().value!)
}
export function forgetWarm(prefix?: string) {
  for (const map of [prefetched, cachedSeq] as Map<string, unknown>[])
    for (const key of [...map.keys()]) if (prefix === undefined || key.startsWith(prefix)) map.delete(key)
}

// ---- the delayed "Syncing" state per session ----

const syncing = new Map<string, SyncIndicator>()
const visible = new Set<string>()
const listeners = new Set<() => void>()
const notify = () => { for (const listener of listeners) listener() }
/** A load began with nothing to draw: the pane's loader shows after 400 ms and then stays at least 400 ms. */
export function startSyncing(key: string) {
  let indicator = syncing.get(key)
  if (!indicator) {
    indicator = createSyncIndicator({ onChange: shown => { if (shown) visible.add(key); else visible.delete(key); notify() } })
    syncing.set(key, indicator)
  }
  indicator.start()
}
export function stopSyncing(key: string) {
  syncing.get(key)?.stop()
}
export function disposeSyncing(key: string) {
  const indicator = syncing.get(key)
  if (!indicator) return
  indicator.dispose()
  syncing.delete(key)
  if (visible.delete(key)) notify()
}
export const isSyncingVisible = (key: string) => visible.has(key)
export function useSyncingVisible(key: string | null): boolean {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => !!key && visible.has(key))
}
