// File-tab preferences (ADE-60/61), kept with the rest of the UI state (`shell/persist.ts`): whether long lines wrap.
import { useSyncExternalStore } from 'react'
import { load, save } from '../shell/persist.ts'

const WRAP = 'kybern.files.wrap'
const listeners = new Set<() => void>()
let wrap: boolean | null = null
const read = () => (wrap ??= load<boolean>(WRAP, true))

/** "Wrap lines" (on by default): code in file tabs wraps at the editor's width; off, long lines scroll sideways. */
export function useWrapLines(): boolean {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, read)
}
export function setWrapLines(on: boolean) {
  wrap = on
  save(WRAP, on)
  for (const listener of listeners) listener()
}
