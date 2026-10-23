// The pending "Save changes?" request for a file tab with unsaved edits (ADE-61). UI-free, so `open.ts` (loaded by fixtures
// before any React or native module) can raise it; `CloseDirty.tsx` shows it.
import { useSyncExternalStore } from 'react'

export interface CloseDirtyRequest { leafId: string; key: string; buffer: string; name: string }
let pending: CloseDirtyRequest | null = null
const listeners = new Set<() => void>()

export function requestCloseDirty(request: CloseDirtyRequest | null) { pending = request; for (const listener of listeners) listener() }
export function useCloseDirtyRequest() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => pending)
}
