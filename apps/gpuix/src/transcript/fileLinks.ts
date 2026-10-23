// Where a clicked file link or file chip opens. A thread's files are named from its workspace root, but an agent writes links
// from wherever its shell is (`sidebar/rows.tsx` after `cd apps/gpuix/src`), so the daemon says which workspace file a path
// means (`threads.files.resolve`: from the root, or the one file that ends with it) before the tab is opened.
import type { ThreadId } from '../../../../packages/kybern-client/src/types.ts'

type Resolver = { call(method: 'threads.files.resolve', params: { thread_id: ThreadId; paths: string[] }): Promise<{ paths: (string | null)[] }> }

/** The workspace-relative path `path` names, or null when the daemon cannot place it (missing, outside, or several files match). */
export async function resolveWorkspaceFile(client: Resolver | null | undefined, threadId: ThreadId, path: string): Promise<string | null> {
  try { return (await client?.call('threads.files.resolve', { thread_id: threadId, paths: [path] }))?.paths[0] ?? null } catch { return null }
}

/** `path` made relative to `cwd` when it lies under it. */
export function underWorkspace(path: string, cwd: string | null | undefined): string | null {
  if (!cwd || !path.startsWith('/')) return null
  const root = cwd.replace(/\/+$/, '')
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null
}

const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|avif)$/i
export const isImageFile = (path: string) => IMAGE_FILE.test(path)
