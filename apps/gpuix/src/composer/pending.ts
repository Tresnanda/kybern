// Optimistic sends (model and transcript merge: `packages/kybern-client/src/pendingSends.ts`). This module is the app's
// one store, its React bindings, and the reset when the daemon environment changes. A rejected send stays as a failed
// bubble with Retry and Edit (`transcript/Turn.tsx`).
import { useSyncExternalStore } from 'react'
import { createPendingStore, type PendingSend } from '../../../../packages/kybern-client/src/pendingSends.ts'
import type { ThreadId } from '../../../../packages/kybern-client/src/types.ts'

export { settledPending, withPending, type PendingSend } from '../../../../packages/kybern-client/src/pendingSends.ts'

const store = createPendingStore()
export const subscribePending = store.subscribe
export const pendingFor = store.pendingFor
export const addPending = store.add
export const updatePending = store.update
export const removePending = store.remove

export function usePendingSends(threadId: ThreadId | null | undefined) {
  return useSyncExternalStore(subscribePending, () => pendingFor(threadId))
}
export function usePendingSend(threadId: ThreadId | null | undefined, id: string | undefined): PendingSend | null {
  return useSyncExternalStore(subscribePending, () => (id ? pendingFor(threadId).find(p => p.id === id) ?? null : null))
}
