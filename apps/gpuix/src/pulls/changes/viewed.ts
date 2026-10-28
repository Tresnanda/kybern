// The reader's Viewed marks and closed folders, kept in the shell's per-environment store under one key and
// shared by every open Changes tab (the page and the dock) through a small subscription.
import { useCallback, useSyncExternalStore } from 'react'
import { load, save } from '../persist.ts'
import { setClosed, setViewed, type FileMeta, type PrViewed, type ViewedStore } from './model.ts'

const KEY = 'pulls.viewed'
const EMPTY: ViewedStore = {}
const listeners = new Set<() => void>()
const read = (): ViewedStore => load<ViewedStore>(KEY, EMPTY)
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
function write(next: ViewedStore) { save(KEY, next); for (const fn of listeners) fn() }

export function useViewed(key: string): { entry: PrViewed | undefined; mark: (files: readonly FileMeta[], on: boolean) => void; close: (closed: readonly string[]) => void } {
  const store = useSyncExternalStore(subscribe, read)
  const mark = useCallback((files: readonly FileMeta[], on: boolean) => write(setViewed(read(), key, files, on)), [key])
  const close = useCallback((closed: readonly string[]) => write(setClosed(read(), key, closed)), [key])
  return { entry: store[key], mark, close }
}
