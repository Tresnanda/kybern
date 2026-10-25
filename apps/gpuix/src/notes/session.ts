// Native counterpart of desktop noteSession: 500 ms debounce, serialized saves,
// persistent drafts, conservative line merge and explicit conflict resolution.
import type { Note, NoteCategory } from '../../../../packages/kybern-client/src/types.ts'
import { mergeNoteBodies } from '@/state/noteLines'
import { activeEnvironment, onEnvironmentLeaving } from '../shell/environment.ts'
import { load, save } from '../shell/persist.ts'
import { getNotes, recordNote, rpc, subscribeNotes } from './store.ts'
export const AUTOSAVE_MS = 500
interface Draft { title: string; body: string; baseRevision: number }
interface Snapshot { note: Note | null; title: string; body: string; phase: 'loading' | 'ready' | 'missing' | 'error'; status: 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'; error: string | null; conflict: Note | null; epoch: number }
export class NoteSession {
  private snap: Snapshot = { note: null, title: '', body: '', phase: 'loading', status: 'saved', error: null, conflict: null, epoch: 0 }
  private listeners = new Set<() => void>()
  private timer?: ReturnType<typeof setTimeout>
  private writing: Promise<void> | null = null
  private off?: () => void
  private refreshing = false
  private generation = 0
  private mounted = 0
  private retryDelay = 1000
  private draftKey: string
  /** The environment this note lives in; once it is left, nothing here talks to the daemon again. */
  private readonly environment = activeEnvironment()
  private readonly client: ReturnType<typeof rpc>
  private retired = false
  private get live() { return !this.retired && this.environment === activeEnvironment() }
  constructor(readonly id: string) { this.client = rpc(id); this.draftKey = `kybern.notes.draft:env:note:${id}` }
  getSnapshot = () => this.snap
  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l) } }
  private set(patch: Partial<Snapshot>) { this.snap = { ...this.snap, ...patch }; this.listeners.forEach((l) => l()) }
  private persist() { if (this.snap.note) save(this.draftKey, { title: this.snap.title, body: this.snap.body, baseRevision: this.snap.note.revision } satisfies Draft) }
  /** Leaving the environment: keep unsaved text as its draft (restored on return) and stop all timers. */
  retire() {
    if (this.retired) return
    if (this.snap.status !== 'saved' && !this.snap.note?.deleted_at) this.persist()
    this.retired = true
    clearTimeout(this.timer)
    this.off?.()
    this.off = undefined
  }
  attach() { if (++this.mounted > 1) return; this.off = subscribeNotes(() => void this.remote()); if (this.snap.phase !== 'ready') void this.reload(); else void this.remote() }
  detach() { if (--this.mounted > 0) return; this.off?.(); this.off = undefined; clearTimeout(this.timer); void this.flush() }
  async reload() {
    if (!this.live) return
    try {
      const { note } = await this.client.call('notes.get', { id: this.id })
      if (!this.live) return
      if (!note) { this.set({ phase: 'missing' }); return }
      const draft = load<Draft | null>(this.draftKey, null)
      this.adopt(note)
      if (draft && typeof draft.body === 'string' && typeof draft.title === 'string' && (draft.body !== note.body || draft.title !== note.title)) {
        this.set({ title: draft.title, body: draft.body, status: draft.baseRevision !== note.revision ? 'conflict' : 'dirty', conflict: draft.baseRevision !== note.revision ? note : null, epoch: this.snap.epoch + 1 })
        this.persist()
        if (!this.snap.conflict && !note.deleted_at) this.schedule()
      }
    } catch (e) { this.set({ phase: 'error', error: String(e) }) }
  }
  private adopt(note: Note) { this.generation++; this.set({ note, title: note.title, body: note.body, phase: 'ready', status: 'saved', conflict: null, error: null, epoch: this.snap.epoch + 1 }); save(this.draftKey, undefined) }
  edit(patch: { title?: string; body?: string }) {
    if (!this.snap.note || this.snap.note.deleted_at) return
    this.generation++
    this.set({ ...patch, status: this.snap.conflict ? 'conflict' : this.writing ? 'saving' : 'dirty', error: null })
    this.persist()
    if (!this.snap.conflict) this.schedule()
  }
  private schedule() { clearTimeout(this.timer); this.timer = setTimeout(() => void this.flush(), AUTOSAVE_MS) }
  private async remote() {
    const summary = getNotes().notes.find((n) => n.id === this.id)
    if (!this.live || !summary || !this.snap.note || this.writing || this.refreshing || this.snap.conflict) return
    if (summary.revision <= this.snap.note.revision && !!summary.deleted_at === !!this.snap.note.deleted_at) return
    this.refreshing = true
    try { const { note } = await this.client.call('notes.get', { id: this.id }); if (this.live && note && !this.writing) this.merge(note) }
    catch { /* Reconnect or the next notification retries. */ }
    finally { this.refreshing = false }
  }
  private merge(note: Note) {
    const base = this.snap.note!
    if (note.revision < base.revision) return
    if (this.snap.title === base.title && this.snap.body === base.body) { this.adopt(note); return }
    const titleClash = this.snap.title !== base.title && note.title !== base.title && this.snap.title !== note.title
    const body = titleClash ? null : mergeNoteBodies(base.body, this.snap.body, note.body)
    if (body === null) { this.set({ conflict: note, status: 'conflict' }); this.persist(); return }
    this.set({ note, title: this.snap.title === base.title ? note.title : this.snap.title, body, epoch: this.snap.epoch + 1, status: 'dirty' })
    this.persist(); if (!note.deleted_at) this.schedule()
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer)
    if (!this.live) return
    if (this.writing) { await this.writing; if (this.snap.status === 'dirty') return this.flush(); return }
    const base = this.snap.note
    if (!base || base.deleted_at || this.snap.conflict) return
    const { title, body } = this.snap
    if (title === base.title && body === base.body) { this.set({ status: 'saved' }); save(this.draftKey, undefined); return }
    const generation = this.generation
    this.persist(); this.set({ status: 'saving' })
    this.writing = (async () => {
      try {
        const note = await this.client.call('notes.update', { id: this.id, expected_revision: base.revision, ...(base.scope === 'thread' ? {} : { title }), body })
        // Saved in the environment it belongs to; don't touch the next one's state.
        if (!this.live) return
        this.retryDelay = 1000
        this.set({ note, status: generation === this.generation ? 'saved' : 'dirty', error: null })
        if (generation === this.generation) save(this.draftKey, undefined)
        else this.persist()
        recordNote(note)
      } catch (e) {
        if (!this.live) return
        if ((e as { code?: number }).code === -32004) {
          try { const { note } = await this.client.call('notes.get', { id: this.id }); if (note) this.merge(note); else this.set({ phase: 'missing' }) }
          catch (error) { this.set({ status: 'error', error: String(error) }) }
        } else {
          this.set({ status: 'error', error: String(e) })
          // Only pending network failures retry. A daemon refusal waits for a
          // new edit or Retry; saved documents never arm a timer.
          if (!(e as { code?: number }).code && this.mounted) {
            clearTimeout(this.timer)
            this.timer = setTimeout(() => void this.flush(), this.retryDelay)
            this.retryDelay = Math.min(15000, this.retryDelay * 2)
          }
        }
      }
    })()
    await this.writing
    this.writing = null
    if (!this.live) return
    if (this.snap.status === 'dirty') { if (this.mounted) this.schedule(); else await this.flush() }
    if (this.mounted) void this.remote()
  }
  /** Save the text first, then set (or, with `null`, clear) the category: it changes no content, so the draft is untouched. */
  async setCategory(category: NoteCategory | null) {
    await this.flush()
    const base = this.snap.note
    if (!this.live || !base || base.deleted_at || this.snap.conflict || this.snap.status !== 'saved' || (base.category ?? null) === category) return
    const change = category ? { category } : { clear_category: true }
    const note = await this.client.call('notes.update', { id: this.id, expected_revision: base.revision, ...change })
    if (!this.live) return
    this.set({ note: { ...base, ...note }, error: null })
    recordNote(note)
  }
  useTheirs() { if (this.snap.conflict) this.adopt(this.snap.conflict) }
  keepMine() { if (!this.snap.conflict) return; this.set({ note: this.snap.conflict, conflict: null, status: 'dirty' }); this.persist(); void this.flush() }
}
// Sessions survive a quick page switch while a save is in flight; clean idle
// sessions are evicted, so visiting notes cannot grow memory without bound.
const sessions = new Map<string, NoteSession>()
export function noteSession(id: string) {
  let session = sessions.get(id)
  if (!session) { session = new NoteSession(id); sessions.set(id, session) }
  if (sessions.size > 24) for (const [key, value] of sessions) { if (key !== id && value.getSnapshot().status === 'saved') { sessions.delete(key); if (sessions.size <= 24) break } }
  return session
}
onEnvironmentLeaving(() => {
  for (const session of sessions.values()) session.retire()
  sessions.clear()
})
