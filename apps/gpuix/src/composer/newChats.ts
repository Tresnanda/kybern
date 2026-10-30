// The new chats this window started whose threads the daemon may not have yet (`packages/kybern-client/src/newChat.ts`).
// A leaf module: `state.ts` merges their threads into the list and opens them without a `threads.get`, the composer
// delivers their first message through `threads.create` (or the task and Coordinator calls), and the transcript says
// "Preparing worktree…" while a worktree is being made.
import { useSyncExternalStore } from 'react'
import { clientThreadIds, createNewChats, type NewChat } from '../../../../packages/kybern-client/src/newChat.ts'
import type { ThreadId } from '../../../../packages/kybern-client/src/types.ts'

export const newChats = createNewChats()

export function useNewChat(threadId: ThreadId | null | undefined): NewChat | undefined {
  return useSyncExternalStore(newChats.subscribe, () => newChats.get(threadId))
}

/** Whether a daemon of `version` makes the thread this window names (0.15.0+); older ones get the awaited create.
 *  `KYBERN_GROUPS` overrides it as it does the group UI (`groups/store.ts`), for fixtures and pre-release daemons. */
export function optimisticCreates(version: string | null | undefined): boolean {
  if (process.env.KYBERN_GROUPS === '1') return true
  if (process.env.KYBERN_GROUPS === '0') return false
  return clientThreadIds(version)
}
