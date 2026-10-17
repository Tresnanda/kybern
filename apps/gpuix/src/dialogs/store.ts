import { useSyncExternalStore } from 'react'
import type { ProviderKind } from '../../../../packages/kybern-client/src/types.ts'
import { onEnvironmentChange } from '../shell/environment.ts'
type Dialog = { kind: 'project' } | { kind: 'worktree'; threadId: string } | { kind: 'account'; provider?: ProviderKind; instance?: string }
let dialog: Dialog | null = null
const listeners = new Set<() => void>()
export function showDialog(next: Dialog | null) { dialog = next; for (const listener of listeners) listener() }
export function useDialog() { return useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn) } }, () => dialog) }
onEnvironmentChange(() => showDialog(null))
