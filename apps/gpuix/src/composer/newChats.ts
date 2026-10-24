// The new chats this window started whose threads the daemon may not have yet (`packages/kybern-client/src/newChat.ts`).
// A leaf module: `state.ts` merges their threads into the list and opens them without a `threads.get`, the composer
// delivers their first message through `threads.create` (or the task and Coordinator calls), and the transcript says
// "Preparing worktree…" while a worktree is being made.
import { useSyncExternalStore } from 'react'
import { createNewChats, type NewChat } from '../../../../packages/kybern-client/src/newChat.ts'
import type { ThreadId } from '../../../../packages/kybern-client/src/types.ts'
import { onEnvironmentChange } from '../shell/environment.ts'

export const newChats = createNewChats()
onEnvironmentChange(() => newChats.clear())

export function useNewChat(threadId: ThreadId | null | undefined): NewChat | undefined {
  return useSyncExternalStore(newChats.subscribe, () => newChats.get(threadId))
}
