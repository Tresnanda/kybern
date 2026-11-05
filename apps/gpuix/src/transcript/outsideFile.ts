// A link to a file outside the thread's workspace (an agent's scratchpad, /tmp, another repository). The daemon says whether it
// opens (`threads.files.outside`); on the desktop of the daemon's own machine an unallowed one asks first, and the answer is
// remembered there: once, or for the file's folder. Every other client sees it refused. The window shows the question
// (`OutsideFileDialog.tsx`); UI-free here so the link handlers and the checks can use it.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ThreadFileOutsideParams, ThreadFileOutsideResult, ThreadId } from '../../../../packages/kybern-client/src/types.ts'

type Asker = { call(method: 'threads.files.outside', params: ThreadFileOutsideParams): Promise<ThreadFileOutsideResult> }
export type OutsideChoice = 'once' | 'folder'
export interface OutsideRequest { path: string; scratch: boolean; folder: boolean; answer: (choice: OutsideChoice | null) => void }

let pending: OutsideRequest | null = null
const listeners = new Set<() => void>()
const emit = () => { for (const listener of listeners) listener() }

/** The question being asked, for the dialog and the checks. */
export const currentOutsideRequest = () => pending

export function useOutsideRequest() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => pending)
}

/** Ask whether to open `path` read-only; null when the question was dismissed. A new question dismisses the one before it. */
export function askOutside(info: Pick<OutsideRequest, 'path' | 'scratch' | 'folder'>): Promise<OutsideChoice | null> {
  pending?.answer(null)
  return new Promise((resolve) => {
    const request: OutsideRequest = {
      ...info,
      answer: (choice) => { if (pending === request) { pending = null; emit() } resolve(choice) },
    }
    pending = request
    emit()
  })
}

/** The first choice is the default: the scratchpad's folder is the agent's own, so allowing it for good comes first. */
export const outsideChoices = (request: Pick<OutsideRequest, 'scratch' | 'folder'>): OutsideChoice[] =>
  !request.folder ? ['once'] : request.scratch ? ['folder', 'once'] : ['once', 'folder']

/**
 * What to open for a link the workspace cannot place: the file's path once it may open, `'cancelled'` when the user said no,
 * or null when it is not a file outside the workspace (the link then opens as written). A file that cannot open says why.
 */
export async function allowOutsideFile(client: Asker | null | undefined, threadId: ThreadId, path: string): Promise<string | 'cancelled' | null> {
  if (!client) return null
  let result: ThreadFileOutsideResult
  try { result = await client.call('threads.files.outside', { thread_id: threadId, path }) } catch { return null }
  if (result.verdict === 'ask') {
    const choice = await askOutside({ path: result.path ?? path, scratch: !!result.scratch, folder: !!result.folder })
    if (!choice) return 'cancelled'
    result = await client.call('threads.files.outside', { thread_id: threadId, path, allow: choice })
  }
  if (result.verdict === 'open') return result.path ?? path
  throw new Error(result.reason ?? "This file is outside the conversation's workspace.")
}

const MAX_KNOWN = 500
/** Per thread and path: whether this client cannot open the link. Answered once; a path that failed to answer stays openable. */
const refusals = new Map<string, boolean>()
const asked = new Set<string>()

/**
 * Which of the answer's absolute file links this client cannot open (outside the workspace, and neither allowed nor askable here).
 * They show as plain text instead of failing after the click. Unanswered links stay links.
 */
export function useRefusedFileLinks(threadId: ThreadId | null | undefined, client: () => Asker | null | undefined, paths: readonly string[]): ReadonlySet<string> {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const asker = threadId && paths.length ? client() : null
    if (!asker || !threadId) return
    let live = true
    for (const path of paths) {
      const key = `${threadId}|${path}`
      if (refusals.has(key) || asked.has(key)) continue
      asked.add(key)
      void asker.call('threads.files.outside', { thread_id: threadId, path }).then(
        (result) => { if (refusals.size >= MAX_KNOWN) refusals.clear(); refusals.set(key, result.verdict === 'refused') },
        () => { refusals.set(key, false) },
      ).finally(() => { asked.delete(key); if (live) setVersion((n) => n + 1) })
    }
    return () => { live = false }
  }, [threadId, paths])
  return useMemo(() => new Set(paths.filter((path) => threadId && refusals.get(`${threadId}|${path}`))), [threadId, paths, version])
}
