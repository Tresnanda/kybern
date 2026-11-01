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
  /** Fork a thread to another machine (`fork/ForkSheet.tsx`); `machineId` names the thread's machine when it is not this one. */
  | { kind: 'fork'; threadId: string; machineId?: string }
  /** Continue a thread on another machine (the same sheet, `mode="move"`): the thread moves and this one becomes read-only. */
  | { kind: 'move'; threadId: string; machineId?: string }
  /** Add a project to another machine (`provision/ProvisionSheet.tsx`); `machineId` is the machine of the row it was opened on. */
  | { kind: 'provision'; projectId: string; machineId?: string }
  | { kind: 'account'; provider?: ProviderKind; instance?: string }
  /** The one-time Antigravity sign-in notice; `proceed` starts the sign-in once it is accepted. */
  | { kind: 'antigravity-notice'; proceed: () => void }
let dialog: Dialog | null = null
const listeners = new Set<() => void>()
export type WorkspaceDialog = NonNullable<typeof dialog>
export function showDialog(next: Dialog | null) { dialog = next; for (const listener of listeners) listener() }
export function useDialog() { return useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn) } }, () => dialog) }
