import { httpBase } from '../../../../packages/kybern-client/src/address.ts'
import { homeClient, sharesHome, watchGlobalNotesHome } from './home.ts'
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
interface State { notes: NoteSummary[]; loaded: boolean; error: string | null; selected: string | null; filter: NotesFilter; display: Display; quick: boolean; capture: Capture | null; query: string }
const defaults: Display = { layout: 'gallery', group: 'none', sort: 'edited', hints: true, outline: true }
const initialState = (): State => ({ notes: [], loaded: false, error: null, selected: load<string | null>('kybern.notes.lastOpenId', null), filter: { kind: 'all' }, display: { ...defaults, ...load<Partial<Display>>('kybern.notes.display', {}) }, quick: false, capture: null, query: '' })
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
const homeIds = new Set<string>()
export function rpc(id?: string, global = false) { const client = sharesHome() && (global || (id && homeIds.has(id))) ? homeClient(() => void refreshNotes()) : getClient(); if (!client) throw new Error('Reconnect to save your note.'); return client }
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
        if (sharesHome()) {
          const home = await homeClient(() => void refreshNotes()).call('notes.list', {}).catch((error) => {
            if (owner === activeEnvironment()) setNotes({ notes: [...result.notes.filter((note) => note.scope !== 'global'), ...state.notes.filter((note) => homeIds.has(note.id))], loaded: true, error: `Global notes on this Mac are unavailable. Reconnect and try again. ${String(error)}` })
            return null
          })
          if (!home) return
          if (owner !== activeEnvironment()) return
          homeIds.clear()
          const globals = home.notes.filter((note) => note.scope === 'global')
          globals.forEach((note) => homeIds.add(note.id))
          setNotes({ notes: [...result.notes.filter((note) => note.scope !== 'global'), ...globals], loaded: true, error: null })
        } else {
          homeIds.clear()
          setNotes({ notes: result.notes, loaded: true, error: null })
        }
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
  homeIds.clear()
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
    const unwatch = watchGlobalNotesHome(() => { homeIds.clear(); setNotes({ selected: null, notes: [], loaded: false }); void refreshNotes() })
    return () => { off(); stop?.(); unwatch() }
  }, [])
}
export async function createNote(body = '', title = '', projectId?: string): Promise<Note | null> {
  try {
    const home = currentNoteHome()
    const project = projectId === '' ? undefined : projectId ?? (home.scope === 'project' ? home.projectId : undefined)
    const note = await rpc(undefined, !project).call('notes.create', { scope: project ? 'project' : 'global', project_id: project, title, body })
    if (!project && sharesHome()) homeIds.add(note.id)
    recordNote(note)
    return note
  } catch (e) { toast.error('Couldn’t create note', { description: String(e) }); return null }
}
export async function newNote() { const note = await createNote(); if (note) openNote(note.id) }
export async function deleteNote(id: string) {
  try { recordNote(await rpc(id).call('notes.delete', { id })); if (state.selected === id) gallery(); toast('Note deleted', { action: { label: 'Undo', onClick: () => void restoreNote(id) } }) }
  catch (e) { toast.error('Couldn’t delete note', { description: String(e) }) }
}
export async function restoreNote(id: string) {
  try { recordNote(await rpc(id).call('notes.restore', { id })) }
  catch (e) { toast.error('Couldn’t restore note', { description: String(e) }) }
}

export async function searchNotes(query: string) {
  const env = await rpc().call('notes.search', { query, limit: 200 })
  if (!sharesHome()) return env.results
  const home = await homeClient(() => void refreshNotes()).call('notes.search', { query, limit: 200 })
  return [...env.results.filter((note) => state.notes.some((n) => n.id === note.id && n.scope !== 'global')), ...home.results.filter((note) => homeIds.has(note.id))]
}

/** Match desktop's cross-environment move: copy first, then soft-delete the original. */
export async function moveNote(id: string, projectId?: string) {
  const owner = activeEnvironment()
  const source = rpc(id), target = rpc(undefined, !projectId)
  if (source === target) {
    recordNote(await source.call('notes.move', { id, scope: projectId ? 'project' : 'global', project_id: projectId }))
    return id
  }
  const { note } = await source.call('notes.get', { id })
  if (!note) throw Error('This note is unavailable.')
  let body = note.body
  const assets = [...new Set([...body.matchAll(/!\[(?:\\.|[^\]])*\]\(kybern:\/\/asset\/([a-f\d-]{36})\)/gi)].map((match) => match[1]!))]
  for (const id of assets) {
    const response = await fetch(`${httpBase(source.endpoint.url)}/assets/${id}`, { headers: { authorization: `Bearer ${source.endpoint.token}` } })
    if (!response.ok) throw Error('Couldn’t copy a note image. The original note has not moved.')
    const image = await response.blob()
    if (image.size > 12 * 1024 * 1024 || !image.type.startsWith('image/')) throw Error('This image cannot be copied here. The original note has not moved.')
    const uploaded = await fetch(`${httpBase(target.endpoint.url)}/assets`, { method: 'POST', headers: { authorization: `Bearer ${target.endpoint.token}`, 'content-type': image.type, 'x-kybern-filename': 'note-image' }, body: image })
    if (!uploaded.ok) throw Error('Couldn’t copy a note image. The original note has not moved.')
    const asset = await uploaded.json() as { id: string }
    body = body.replaceAll(`kybern://asset/${id}`, `kybern://asset/${asset.id}`)
  }
  const copy = await target.call('notes.create', { scope: projectId ? 'project' : 'global', project_id: projectId, title: note.title, body })
  if (note.pinned) await target.call('notes.pin', { id: copy.id, pinned: true })
  await source.call('notes.delete', { id })
  if (owner === activeEnvironment()) { await refreshNotes(); openNote(copy.id) }
  return copy.id
}
