import { useStore } from "./store"

export function offerWorktreeCleanup(threadId: string) {
  useStore.getState().set({ worktreeCleanupThread: threadId })
}
