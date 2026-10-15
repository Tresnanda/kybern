import { useEffect, useSyncExternalStore } from 'react'
import type { Note, NoteSummary } from '../../../../packages/kybern-client/src/types.ts'
import type { NotesFilter, NotesGroupBy, NotesSortBy } from '@/state/notesModel'
import { getClient, getState, subscribe } from '../state.ts'
import { goPage } from '../nav/history.ts'
import { activeEnvironment, onEnvironmentChange } from '../shell/environment.ts'
import { load, save } from '../shell/persist.ts'
import { toast } from '../shell/toasts.tsx'
import { isFreeChatProject } from '../../../../packages/kybern-client/src/types.ts'
import { resolveNewNoteHome } from '@/state/notesModel'

export interface Capture { text: string; threadTitle: string; threadId: string }
interface Display { layout: 'gallery' | 'list'; group: NotesGroupBy; sort: NotesSortBy; hints: boolean; outline: boolean }
interface State { notes: NoteSummary[]; loaded: boolean; error: string | null; selected: string | null; filter: NotesFilter; display: Display; quick: boolean; capture: Capture | null }
const defaults: Display = { layout: 'gallery', group: 'none', sort: 'edited', hints: true, outline: true }
const initialState = (): State => ({ notes: [], loaded: false, error: null, selected: load<string | null>('kybern.notes.lastOpenId', null), filter: { kind: 'all' }, display: { ...defaults, ...load<Partial<Display>>('kybern.notes.display', {}) }, quick: false, capture: null })
let state: State = initialState()
const listeners = new Set<() => void>()
export const getNotes = () => state
export function setNotes(patch: Partial<State>) { state = { ...state, ...patch }; listeners.forEach((l) => l()) }
export const subscribeNotes = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
export function useNotes<T>(select: (s: State) => T): T { return useSyncExternalStore(subscribeNotes, () => select(state)) }
export function display(patch: Partial<Display>) { const value = { ...state.display, ...patch }; setNotes({ display: value }); save('kybern.notes.display', value) }
export function openNote(id: string) { setNotes({ selected: id }); save('kybern.notes.lastOpenId', id); goPage('notes') }
export function gallery() { setNotes({ selected: null }) }
export function openQuickNote() { setNotes({ quick: true }) }
export function currentNoteHome() {
  const app = getState()
  const projectId = app.selectedId ? app.threads.find((t) => t.id === app.selectedId)?.project_id : app.draft.projectId
  return resolveNewNoteHome({ focus: state.filter.kind === 'global' ? { kind: 'global' } : state.filter.kind === 'project' ? { kind: 'project', projectId: state.filter.projectId } : null, openNote: state.notes.find((n) => n.id === state.selected) ?? null, contextProjectId: projectId && !isFreeChatProject(projectId) ? projectId : null, projects: Object.fromEntries(app.projects.map((p) => [p.id, p])) })
}
/** The transcript owns its entry point; this opens the shared picker without coupling it to Notes UI. */
export function openSaveToNote(capture: Capture) { setNotes({ capture }) }
export function recordNote(note: NoteSummary) {
  const previous = state.notes.find((n) => n.id === note.id)
  if (previous && previous.revision > note.revision) return
  setNotes({ notes: [note, ...state.notes.filter((n) => n.id !== note.id)] })
}
export function rpc() { const client = getClient(); if (!client) throw new Error('Reconnect to save your note.'); return client }
let fetching: Promise<void> | null = null
let again = false
export function refreshNotes(): Promise<void> {
  if (fetching) { again = true; return fetching }
  const owner = activeEnvironment()
  const run = (async () => {
    do {
      again = false
      try {
        const result = await rpc().call('notes.list', {})
        if (owner !== activeEnvironment()) return
        setNotes({ notes: result.notes, loaded: true, error: null })
      } catch (e) {
        if (owner !== activeEnvironment()) return
        setNotes({ error: String(e) })
      }
    } while (again)
  })().finally(() => { if (fetching === run) fetching = null })
  fetching = run
  return run
}
// A switch starts from the new environment's notes and its saved preferences.
onEnvironmentChange(() => {
  fetching = null
  again = false
  setNotes(initialState())
})
/** One live feed while the app is mounted. No polling; reconnect reloads the list. */
export function useNotesFeed() {
  useEffect(() => {
    let client = getClient()
    let stop: (() => void) | undefined
    let status = ''
    const sync = () => {
      const next = getClient()
      if (next !== client || !stop) { stop?.(); client = next; stop = client?.onNotification('notes.changed', () => void refreshNotes()) }
      const nextStatus = getState().status
      if (nextStatus === 'open' && status !== 'open') void refreshNotes()
      status = nextStatus
    }
    sync()
    const off = subscribe(sync)
    return () => { off(); stop?.() }
  }, [])
}
export async function createNote(body = '', title = '', projectId?: string): Promise<Note | null> {
  try {
    const home = currentNoteHome()
    const project = projectId === '' ? undefined : projectId ?? (home.scope === 'project' ? home.projectId : undefined)
    const note = await rpc().call('notes.create', { scope: project ? 'project' : 'global', project_id: project, title, body })
    recordNote(note)
    return note
  } catch (e) { toast.error('Couldn’t create note', { description: String(e) }); return null }
}
export async function newNote() { const note = await createNote(); if (note) openNote(note.id) }
export async function deleteNote(id: string) {
  try { recordNote(await rpc().call('notes.delete', { id })); if (state.selected === id) gallery(); toast('Note deleted', { action: { label: 'Undo', onClick: () => void restoreNote(id) } }) }
  catch (e) { toast.error('Couldn’t delete note', { description: String(e) }) }
}
export async function restoreNote(id: string) {
  try { recordNote(await rpc().call('notes.restore', { id })) }
  catch (e) { toast.error('Couldn’t restore note', { description: String(e) }) }
}
