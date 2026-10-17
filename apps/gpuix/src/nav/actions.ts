// Thread and project writes from the panel, title bar and dialogs, with the
// desktop's RPCs (`state/rpc.ts`). Each updates the lists at once; the events
// subscription confirms them.
import { seedFromGet } from '../../../../packages/kybern-client/src/transcript.ts'
import type { ProviderInstance, SavedSession, Thread, ThreadId } from '../../../../packages/kybern-client/src/types.ts'
import { getClient, getState, refreshLists, selectDraft, selectThread, set } from '../state.ts'
import { markArchived } from './live.ts'
import { getNav, setNav } from './store.ts'

function rpc() {
  const client = getClient()
  if (!client) throw new Error('Not connected to kybernd')
  return client
}

/** The message an error carries, for a dialog line. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function replaceThread(thread: Thread) {
  set({ threads: getState().threads.map((t) => (t.id === thread.id ? thread : t)) })
}

/** Rename or pin (`updateThread`). */
export async function updateThread(threadId: ThreadId, patch: { title?: string; pinned?: boolean }) {
  const thread = await rpc().call('threads.update', { thread_id: threadId, ...patch })
  replaceThread(thread)
  // Pinned threads sort first; keep the list in the desktop's order.
  set({ threads: [...getState().threads].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at)) })
}

export async function archiveThread(threadId: ThreadId) {
  await rpc().call('threads.archive', { thread_id: threadId })
  markArchived(threadId)
  set({ threads: getState().threads.filter((t) => t.id !== threadId) })
  if (getNav().children[threadId]) {
    const children = { ...getNav().children }
    delete children[threadId]
    setNav({ children })
  }
  // Archiving the open thread leaves it on screen, as the desktop does; it reopens from history.
}

/** Start a new thread with another agent, seeded with the conversation so far (`handOff`). */
export async function handOff(threadId: ThreadId, provider: ProviderInstance, model?: string): Promise<ThreadId> {
  const client = rpc()
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
  const project = await rpc().call('projects.add', { path: folder })
  await refreshLists()
  setNav({ page: 'home' })
  selectDraft(project.id)
}

export async function removeProject(projectId: string) {
  await rpc().call('projects.remove', { project_id: projectId })
  await refreshLists()
}
