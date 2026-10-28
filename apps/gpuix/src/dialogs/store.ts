import { useSyncExternalStore } from 'react'
import type { ProviderKind } from '../../../../packages/kybern-client/src/types.ts'
type Dialog =
  /** `group`: the folder picker titled "Choose the group folder", which leads to the group sheet. */
  | { kind: 'project'; group?: boolean }
  /** The group sheet for a chosen folder. */
  | { kind: 'group'; path: string }
  /** The members of a group project (sidebar menu, palette, badge card). */
  | { kind: 'repositories'; projectId: string }
  | { kind: 'worktree'; threadId: string }
  | { kind: 'account'; provider?: ProviderKind; instance?: string }
let dialog: Dialog | null = null
const listeners = new Set<() => void>()
export type WorkspaceDialog = NonNullable<typeof dialog>
export function showDialog(next: Dialog | null) { dialog = next; for (const listener of listeners) listener() }
export function useDialog() { return useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn) } }, () => dialog) }
