// Thread and project writes from the panel, title bar and dialogs, with the
// desktop's RPCs (`state/rpc.ts`). Each updates the lists at once; the events
// subscription confirms them.
import { errorMessage } from '../../../../packages/kybern-client/src/problem.ts'
import { seedFromGet } from '../../../../packages/kybern-client/src/transcript.ts'
import type { ProviderInstance, SavedSession, Thread, ThreadId } from '../../../../packages/kybern-client/src/types.ts'
import { getState, projectClient, refreshLists, selectDraft, selectThread, set, threadClient, type StateThread } from '../state.ts'
import { markArchived, markUnarchived } from './live.ts'
import { toast } from '../shell/toasts.tsx'
import { toastProblem } from '../problems/toast.ts'
import { getNav, setNav } from './store.ts'
import { addProjectToCurrentSpace } from '../spaces/add.ts'

/** The client of the machine that owns a thread (or a project); the machine the user is at when neither is given. */
function rpc(owner: { thread?: ThreadId; project?: string } = {}) {
  const client = owner.project ? projectClient(owner.project) : threadClient(owner.thread)
  if (!client) throw new Error('Not connected to kybernd')
  return client
}

/** The message an error carries, for a dialog line. */
export function errorText(error: unknown): string {
  return errorMessage(error)
}

function replaceThread(thread: Thread) {
  set({ threads: getState().threads.map((t) => (t.id === thread.id ? thread : t)) })
}

/** Rename, pin, or move out of Older (`updateThread`). */
export async function updateThread(threadId: ThreadId, patch: { title?: string; pinned?: boolean; keep_out_of_older?: boolean; move_out_of_older?: boolean }) {
  const thread = await rpc({ thread: threadId }).call('threads.update', { thread_id: threadId, ...patch })
  replaceThread(thread)
  // Pinned threads sort first; keep the list in the desktop's order.
  set({ threads: [...getState().threads].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at)) })
}

const byPinnedThenRecent = (a: Thread, b: Thread) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at)

/** The sidebar's Archived row counts this machine's archived threads; it moves at once, and the next list read corrects it. */
function countArchived(projectId: string, by: 1 | -1) {
  const counts = { ...getState().archivedCounts }
  const next = (counts[projectId] ?? 0) + by
  if (next > 0) counts[projectId] = next
  else delete counts[projectId]
  set({ archivedCounts: counts })
}

/** Archive a thread. Nothing is deleted: a toast offers Undo for 5 s, and the project's Archived list brings it back later. */
export async function archiveThread(threadId: ThreadId) {
  const owner = rpc({ thread: threadId })
  const listed = getState().threads.find((t) => t.id === threadId) as StateThread | undefined
  await owner.call('threads.archive', { thread_id: threadId })
  markArchived(threadId)
  if (listed && !listed.machineId && !listed.parent_thread_id) countArchived(listed.project_id, 1)
  if (!listed?.parent_thread_id) {
    toast('Thread archived', {
      id: `archived:${threadId}`,
      duration: 5000,
      action: {
        label: 'Undo',
        onClick: () => void unarchiveThread(threadId, owner).catch((e) => toastProblem(e, { action: 'bring the thread back', ...(listed ? { projectId: listed.project_id } : {}) })),
      },
    })
  }
  set({ threads: getState().threads.filter((t) => t.id !== threadId) })
  if (getNav().children[threadId]) {
    const children = { ...getNav().children }
    delete children[threadId]
    setNav({ children })
  }
  // Archiving the open thread leaves it on screen, as the desktop does; it reopens from history.
}

/** Bring an archived thread back (`threads.unarchive`): idle, at the top of its list, ready to continue. `owner` is the
 *  machine it is on when that is not the one the user is at. */
export async function unarchiveThread(threadId: ThreadId, owner: ReturnType<typeof rpc> = rpc({ thread: threadId })): Promise<Thread> {
  const thread = await owner.call('threads.unarchive', { thread_id: threadId })
  markUnarchived(threadId)
  const local = owner === threadClient(null)
  if (local && !thread.parent_thread_id) {
    countArchived(thread.project_id, -1)
    if (!getState().threads.some((t) => t.id === threadId && !(t as StateThread).machineId)) set({ threads: [thread, ...getState().threads].sort(byPinnedThenRecent) })
    else replaceThread(thread)
  } else {
    void refreshLists()
  }
  return thread
}

/** Start a new thread with another agent, seeded with the conversation so far (`handOff`). */
export async function handOff(threadId: ThreadId, provider: ProviderInstance, model?: string): Promise<ThreadId> {
  const client = rpc({ thread: threadId })
  const thread = getState().threads.find((t) => t.id === threadId) ?? getNav().children[threadId]
  if (!thread) throw new Error('Thread not found')
  const open = getState().selectedId === threadId && getState().open.loaded ? getState().open : null
  const t = open ?? seedFromGet(await client.call('threads.get', { thread_id: threadId, include_tool_output: false }))
  const lines: string[] = []
  for (const b of t.blocks) {
    if (b.kind === 'user') {
      const text = b.message.parts
        .map((p) =>
          p.type === 'text'
            ? p.text
            : p.type === 'file_mention'
              ? `@${p.path}`
              : p.type === 'skill'
                ? `$${p.name}`
                : p.type === 'mention'
                  ? `@${p.display_name ?? p.name}`
                  : `[${p.type}]`,
        )
        .join('')
      lines.push(`User:\n${text}`)
    } else if (b.kind === 'assistant' && b.text.trim()) {
      lines.push(`Assistant:\n${b.text.trim()}`)
    } else if (b.kind === 'tool') {
      const detail = typeof b.call.input === 'object' && b.call.input ? JSON.stringify(b.call.input).slice(0, 200) : ''
      lines.push(`Tool ${b.call.name}: ${detail}`)
    }
  }
  const seed = [
    'You are taking over a coding session that another agent started in this repository. Continue from where it left off.',
    'Do not redo completed work. Read the transcript, then ask what to do next if the last request is already done.',
    '',
    'Transcript so far:',
    '',
    lines.join('\n\n'),
  ].join('\n')
  const created = await client.call('threads.create', {
    project_id: thread.project_id,
    provider,
    permission_mode: thread.permission_mode,
    model,
    message: { parts: [{ type: 'text', text: seed }] },
  })
  set({ threads: [created, ...getState().threads.filter((x) => x.id !== created.id)] })
  setNav({ page: 'home' })
  void selectThread(created.id)
  return created.id
}

/** Resume a saved provider session as a Kybern thread, then open it (`SessionsDialog` `resume`). */
export async function resumeSession(session: SavedSession, projectId: string | null) {
  const client = rpc()
  const thread = await client.call('sessions.resume', { provider: session.provider, session_id: session.id, project_id: projectId })
  await refreshLists()
  if (!getNav().sessions) return
  setNav({ page: 'home', sessions: null })
  void selectThread(thread.id)
}

/** Add a project folder (`addProject`) and open its draft. */
export async function addProject(folder: string) {
  await addProjectToCurrentSpace(folder)
}

/**
 * Change a project's display name (never its folder). The sidebar shows the new name at once; a refusal puts the old
 * one back and rejects with the daemon's message.
 */
export async function renameProject(projectId: string, name: string) {
  const before = getState().projects.find((p) => p.id === projectId)
  if (!before) return
  const patch = (value: string) => set({ projects: getState().projects.map((p) => (p.id === projectId ? { ...p, name: value } : p)) })
  patch(name)
  try {
    const project = await rpc({ project: projectId }).call('projects.update', { project_id: projectId, name })
    set({ projects: getState().projects.map((p) => (p.id === projectId ? project : p)) })
  } catch (error) {
    patch(before.name)
    throw error
  }
}

export async function removeProject(projectId: string) {
  await rpc({ project: projectId }).call('projects.remove', { project_id: projectId })
  await refreshLists()
}
