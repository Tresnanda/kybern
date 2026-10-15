import { useEffect, useRef, useState } from 'react'
import { noteMatchesQuery, noteTitle, savedMessageMarkdown, titleFromText } from '@/state/notesModel'
import { isFreeChatProject } from '../../../../packages/kybern-client/src/types.ts'
import { addWindowKeyHandler } from '../nav/keys.ts'
import { getNav, setNav } from '../nav/store.ts'
import { Dialog } from '../nav/overlay.tsx'
import { Button, Select, TextField } from '../settings/controls.tsx'
import { getState, useApp } from '../state.ts'
import { load, save } from '../shell/persist.ts'
import { toast } from '../shell/toasts.tsx'
import { Label, useTheme } from '../ui.tsx'
import { createNote, currentNoteHome, getNotes, newNote, openNote, openQuickNote, recordNote, rpc, setNotes, useNotes, useNotesFeed, type Capture } from './store.ts'

/** Mounted with the palette; the editor and picker themselves unmount when closed. */
export function NotesOverlays() {
  useNotesFeed()
  const quick = useNotes((s) => s.quick)
  const capture = useNotes((s) => s.capture)
  useEffect(() => addWindowKeyHandler((e) => {
    if (!e.modifiers?.cmd || e.modifiers.ctrl || e.modifiers.alt || e.key !== 'n') return
    if (e.modifiers.shift) { setNav({ keyboardNav: true, paletteOpen: false }); openQuickNote(); return true }
    if (getNav().page === 'notes' && !getNav().settingsOpen && !getNotes().quick && !getNotes().capture) { setNav({ keyboardNav: true, paletteOpen: false }); void newNote(); return true }
  }), [])
  return <>{quick && <QuickNote />}{capture && <SaveToNote capture={capture} />}</>
}
const QUICK_KEY = 'kybern.notes.quick'
function QuickNote() {
  const t = useTheme()
  const projects = useApp((s) => s.projects)
  const [draft, setDraft] = useState(() => {
    const value = load<{ title: string; body: string; home: ReturnType<typeof currentNoteHome> } | null>(QUICK_KEY, null)
    const home = value?.home ?? currentNoteHome()
    return { title: value?.title ?? '', body: value?.body ?? '', project: home.scope === 'project' ? home.projectId : '' }
  })
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const update = (patch: Partial<typeof draft>) => { const next = { ...draft, ...patch }; setDraft(next); save(QUICK_KEY, { title: next.title, body: next.body, home: next.project ? { scope: 'project', projectId: next.project } : { scope: 'global' } }) }
  const finish = async () => {
    if (saving.current) return
    if (!draft.title.trim() && !draft.body.trim()) { setNotes({ quick: false }); return }
    saving.current = true; setBusy(true)
    const note = await createNote(draft.body, draft.title || titleFromText(draft.body), draft.project)
    saving.current = false; setBusy(false)
    if (!note) return
    save(QUICK_KEY, undefined); setNotes({ quick: false }); toast('Note saved', { action: { label: 'Open', onClick: () => openNote(note.id) } })
  }
  return <Dialog testId="quick-note" instant={getNav().keyboardNav} width={560} onClose={() => void finish()}>
    <div onKeyDown={(e) => { if (e.modifiers?.cmd && e.key === 'enter') void finish() }} style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><Label color={t.textSecondary} size={12}>New note in</Label><Select label="Note location" value={draft.project} onChange={(project) => update({ project })} options={[{ value: '', label: 'Global' }, ...projects.filter((p) => !isFreeChatProject(p.id)).map((p) => ({ value: p.id, label: p.name }))]} /></div>
      <input testId="quick-note-title" aria-label="Title" autoFocus placeholder="Untitled" value={draft.title} onChange={(e) => update({ title: (e.value ?? '').slice(0, 300) })} style={{ height: 36, fontSize: 24, fontWeight: 600, color: t.text, backgroundColor: t.popover }} />
      <textarea testId="quick-note-body" aria-label="Note" placeholder="Write something…" value={draft.body} minRows={6} maxRows={14} onChange={(e) => update({ body: e.value ?? '' })} theme={{ text: t.text, caret: t.text }} style={{ fontSize: 15, lineHeight: 25, color: t.text, backgroundColor: t.popover }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><Label color={t.textSecondary} size={12} style={{ flexGrow: 1 }}>⌘ ↵ Save note</Label><Button testId="quick-note-save" disabled={busy} onClick={() => void finish()}>{busy ? 'Saving…' : 'Save note'}</Button></div>
    </div>
  </Dialog>
}
function SaveToNote({ capture }: { capture: Capture }) {
  const t = useTheme()
  const all = useNotes((s) => s.notes)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [active, setActive] = useState(0)
  const guard = useRef(false)
  const notes = all.filter((n) => !n.deleted_at && noteMatchesQuery(n, query)).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 50)
  const choices = query && notes.length ? [...notes, null] : [null, ...notes]
  const choose = async (id: string | null) => {
    if (guard.current) return
    guard.current = true; setBusy(true)
    const body = savedMessageMarkdown(capture.text, capture.threadTitle, capture.threadId)
    try {
      let note
      if (!id) {
        const projectId = getState().threads.find((thread) => thread.id === capture.threadId)?.project_id
        note = await createNote(body, titleFromText(capture.text), projectId && !isFreeChatProject(projectId) ? projectId : undefined)
        if (!note) return
      } else {
        const current = (await rpc().call('notes.get', { id })).note
        if (!current || current.deleted_at) throw new Error('This note is unavailable. Choose another note.')
        note = await rpc().call('notes.update', { id, expected_revision: current.revision, body: `${current.body.trimEnd()}${current.body.trim() ? '\n\n' : ''}${body}` })
      }
      recordNote(note); setNotes({ capture: null }); const savedId = note.id
      toast('Saved to note', { action: { label: 'Open', onClick: () => openNote(savedId) } })
    } catch (e) { toast.error('Couldn’t save to note', { description: String(e) }) }
    finally { guard.current = false; setBusy(false) }
  }
  return <Dialog testId="save-to-note" width={400} onClose={() => { if (!busy) setNotes({ capture: null }) }}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16 }}><Label color={t.text} weight={500}>Save to note</Label>
      <TextField testId="save-note-search" autoFocus label="Search notes" placeholder="Search notes" value={query} onChange={(value) => { setQuery(value); setActive(0) }} width="100%" onSubmit={() => void choose(choices[active]?.id ?? null)} onKeyDown={(e) => { if (e.key === 'down') setActive((at) => (at + 1) % choices.length); if (e.key === 'up') setActive((at) => (at - 1 + choices.length) % choices.length) }} />
      <virtual-list style={{ height: Math.min(320, choices.length * 36) }}>{choices.map((note, i) => <div key={note?.id ?? 'new'} testId={`save-note-${note?.id ?? 'new'}`} onClick={() => void choose(note?.id ?? null)} style={{ display: 'flex', alignItems: 'center', padding: 8, borderRadius: 6, backgroundColor: active === i ? t.hover : undefined, cursor: 'pointer', opacity: busy ? 0.5 : 1 }}><Label color={t.text} size={13} truncate>{note ? noteTitle(note) : '+ New note'}</Label></div>)}</virtual-list>
    </div>
  </Dialog>
}
