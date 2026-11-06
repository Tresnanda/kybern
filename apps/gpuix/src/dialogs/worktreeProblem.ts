// Why removing a worktree failed, when the reason is a Windows file lock: another program (an editor, a terminal, a dev server) still has a
// file or the folder itself open. The words name the program when the error does, and say the work is safe, because Kybern saves the source
// to a recovery ref before it removes anything.

/** The program the error blames, when it names one ("Code.exe"). */
const HOLDER = /(?:used by|held by|locked by|open in|in use by)(?: another process)?(?: \(?(?:process |program )?["']?([\w .-]+?\.exe)["']?\)?)?/i
const LOCK = /being used by another process|used by another process|os error (?:32|33)\b|Device or resource busy|EBUSY|Unlink of file .* failed|unable to unlink|cannot remove .*(?:Permission denied|Access is denied)|Access is denied|Permission denied|Directory not empty|ENOTEMPTY/i

export interface WorktreeLock {
  /** The program holding the folder, e.g. "Code", when known. */
  holder?: string
}

/** The lock `message` describes, or `null` when it is some other failure. */
export function worktreeLock(message: string): WorktreeLock | null {
  if (!LOCK.test(message)) return null
  const exe = HOLDER.exec(message)?.[1]?.trim()
  const holder = exe ? exe.replace(/\.exe$/i, '') : undefined
  return holder ? { holder } : {}
}

/** The headline and sentence for a lock. */
export function worktreeLockCopy(lock: WorktreeLock): { title: string; body: string } {
  return {
    title: lock.holder ? `${lock.holder} is using this worktree` : 'A program is using this worktree',
    body: `${lock.holder ? `Close ${lock.holder}` : 'Close any editor, terminal or dev server open in this folder'}, then try again. Your work is safe: the conversation and its source are saved.`,
  }
}
