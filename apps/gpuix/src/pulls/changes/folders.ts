// The folders the reader closed, kept in the shell's per-environment store under one key and shared by every
// open Changes tab (the page and the dock) through a small subscription.
import { useCallback, useSyncExternalStore } from 'react'
import { load, save } from '../persist.ts'
import { setClosed, type FolderStore, type PrFolders } from './model.ts'

const KEY = 'pulls.folders'
const EMPTY: FolderStore = {}
const listeners = new Set<() => void>()
const read = (): FolderStore => load<FolderStore>(KEY, EMPTY)
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
function write(next: FolderStore) { save(KEY, next); for (const fn of listeners) fn() }

export function useClosedFolders(key: string): { entry: PrFolders | undefined; close: (closed: readonly string[]) => void } {
  const store = useSyncExternalStore(subscribe, read)
  const close = useCallback((closed: readonly string[]) => write(setClosed(read(), key, closed)), [key])
  return { entry: store[key], close }
}
