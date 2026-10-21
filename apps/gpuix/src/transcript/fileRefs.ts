// Which inline-code paths of settled answers name files in a thread's
// workspace. Lookups are batched per thread (one `threads.files.resolve` call
// per burst of rows) and cached, so an answer renders as plain code first and
// upgrades to file links once; streaming text never asks.
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { getClient } from '../state.ts'

const MAX_THREADS = 24
const MAX_PATHS = 2000
const BATCH = 200
/** A path that named no file is asked about again after this, in case it was created since. */
const MISS_TTL_MS = 60_000

type Known = { file: string | null; at: number }
const threads = new Map<string, Map<string, Known>>()
const pending = new Map<string, Set<string>>()
const asking = new Set<string>()
const versions = new Map<string, number>()
const listeners = new Map<string, Set<() => void>>()
/** Per thread, how many mounted rows show each path: those answers are never evicted from under their links. */
const inUse = new Map<string, Map<string, number>>()
let timer: ReturnType<typeof setTimeout> | null = null

function known(threadId: string): Map<string, Known> {
  let paths = threads.get(threadId)
  if (paths) { threads.delete(threadId); threads.set(threadId, paths); return paths }
  paths = new Map()
  threads.set(threadId, paths)
  if (threads.size > MAX_THREADS) threads.delete(threads.keys().next().value!)
  return paths
}

const fresh = (entry: Known | undefined, now: number) => !!entry && (entry.file !== null || now - entry.at < MISS_TTL_MS)

function ask(threadId: string, paths: readonly string[]) {
  const cache = known(threadId), now = Date.now()
  let queue = pending.get(threadId)
  for (const path of paths) {
    const key = `${threadId}\n${path}`, entry = cache.get(path)
    // Least recently shown first out: a path a row shows again moves to the end.
    if (fresh(entry, now)) { cache.delete(path); cache.set(path, entry!); continue }
    if (asking.has(key)) continue
    if (!queue) pending.set(threadId, queue = new Set())
    queue.add(path)
  }
  if (queue?.size && !timer) timer = setTimeout(flush, 16)
}

function flush() {
  timer = null
  const batches = [...pending]
  pending.clear()
  for (const [threadId, queue] of batches) {
    const paths = [...queue]
    for (let start = 0; start < paths.length; start += BATCH) void resolve(threadId, paths.slice(start, start + BATCH))
  }
}

async function resolve(threadId: string, paths: string[]) {
  const client = getClient()
  if (!client) return
  const keys = paths.map(path => `${threadId}\n${path}`)
  for (const key of keys) asking.add(key)
  let files: (string | null)[]
  try {
    files = (await client.call('threads.files.resolve', { thread_id: threadId, paths })).paths
  } catch {
    // An older daemon or a vanished thread: keep the spans as code.
    files = paths.map(() => null)
  } finally {
    for (const key of keys) asking.delete(key)
  }
  const cache = known(threadId), at = Date.now()
  paths.forEach((path, i) => { cache.delete(path); cache.set(path, { file: files[i] ?? null, at }) })
  evictUnused(cache, inUse.get(threadId), MAX_PATHS)
  versions.set(threadId, (versions.get(threadId) ?? 0) + 1)
  for (const listener of listeners.get(threadId) ?? []) listener()
}

/** Drops the least recently shown answers until `cache` holds `max`, keeping every path a mounted row shows (clearing it
 *  all, as before, turned visible file links back into code once a long thread passed `MAX_PATHS` spans). */
export function evictUnused(cache: Map<string, unknown>, shown: ReadonlyMap<string, number> | undefined, max: number) {
  if (cache.size <= max) return
  for (const path of cache.keys()) {
    if (cache.size <= max) break
    if (!shown?.get(path)) cache.delete(path)
  }
}

function show(threadId: string, paths: readonly string[]) {
  let counts = inUse.get(threadId)
  if (!counts) inUse.set(threadId, counts = new Map())
  for (const path of paths) counts.set(path, (counts.get(path) ?? 0) + 1)
  return () => {
    for (const path of paths) { const n = (counts.get(path) ?? 1) - 1; if (n > 0) counts.set(path, n); else counts.delete(path) }
    if (!counts.size && inUse.get(threadId) === counts) inUse.delete(threadId)
  }
}

function subscribe(threadId: string, listener: () => void) {
  let set = listeners.get(threadId)
  if (!set) listeners.set(threadId, set = new Set())
  set.add(listener)
  return () => { set.delete(listener); if (!set.size) listeners.delete(threadId) }
}

/**
 * The workspace file each of `paths` names in `threadId` (undefined until
 * known, null when none). Re-renders once per answered batch that touched
 * this thread.
 */
export function useFileRefs(threadId: string | null | undefined, paths: readonly string[]): (path: string) => string | null | undefined {
  const active = threadId && paths.length ? threadId : null
  const version = useSyncExternalStore(
    useMemo(() => (listener: () => void) => (active ? subscribe(active, listener) : () => {}), [active]),
    () => (active ? versions.get(active) ?? 0 : 0),
  )
  useEffect(() => { if (!active) return; ask(active, paths); return show(active, paths) }, [active, paths])
  return useMemo(() => {
    const cache = active ? threads.get(active) : undefined
    return (path: string) => cache?.get(path)?.file
  }, [active, version])
}

/** Test seam: forget every cached lookup. */
export function resetFileRefs() {
  threads.clear(); pending.clear(); asking.clear(); versions.clear(); inUse.clear()
  if (timer) { clearTimeout(timer); timer = null }
}
