import { useEffect, useMemo, useRef, useState } from 'react'
import { noteMatchesQuery, noteTitle, savedMessageMarkdown, titleFromText } from '@/state/notesModel'
import { isFreeChatProject } from '../../../../packages/kybern-client/src/types.ts'
import { addWindowKeyHandler } from '../nav/keys.ts'
import { getNav, setNav } from '../nav/store.ts'
import { Dialog, Menu, MenuItem } from '../nav/overlay.tsx'
import { NOTES_META, ProjectDot, notesTokens } from './kit.tsx'
import { Button } from '../kit/Button.tsx'
import { TextField } from '../kit/Field.tsx'
import { PickerChip } from '../kit/PickerChip.tsx'
import { getClient, getState, useApp } from '../state.ts'
import { useSpaceProjects } from '../spaces/current.ts'
import { RichEditor, type RichEditorHandle } from '../editor/RichEditor.tsx'
import type { ImageHome } from '../editor/images.ts'
import { load, save } from '../shell/persist.ts'
import { toast } from '../shell/toasts.tsx'
import { Label, useTheme } from '../ui.tsx'
import { createNote, currentNoteHome, getNotes, newNote, openNote, openQuickNote, recordNote, rpc, setNotes, useNotes, useNotesFeed, type Capture } from './store.ts'
import { isOtherCommand, isPrimary } from '../platform/keys.ts'

/** Mounted with the palette; the editor and picker themselves unmount when closed. */
export function NotesOverlays() {
  useNotesFeed()
  const quick = useNotes((s) => s.quick)
  const capture = useNotes((s) => s.capture)
  useEffect(() => addWindowKeyHandler((e) => {
    if (!isPrimary(e.modifiers) || isOtherCommand(e.modifiers) || e.modifiers?.alt || e.key !== 'n') return
    if (e.modifiers?.shift) { setNav({ keyboardNav: true, paletteOpen: false }); openQuickNote(); return true }
    if (getNav().page === 'notes' && !getNav().settingsOpen && !getNotes().quick && !getNotes().capture) { setNav({ keyboardNav: true, paletteOpen: false }); void newNote(); return true }
  }), [])
  return <>{quick && <QuickNote />}{capture && <SaveToNote capture={capture} />}</>
}
const QUICK_KEY = 'kybern.notes.quick'
function QuickNote() {
  const t = useTheme()
  const everyProject = useApp((s) => s.projects)
  const projects = useSpaceProjects()
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
    const text = body.current?.read() ?? draft.body
    if (!draft.title.trim() && !text.trim()) { setNotes({ quick: false }); return }
    saving.current = true; setBusy(true)
    const note = await createNote(text, draft.title || titleFromText(text), draft.project)
    saving.current = false; setBusy(false)
    if (!note) return
    save(QUICK_KEY, undefined); setNotes({ quick: false }); toast('Note saved', { action: { label: 'Open', onClick: () => openNote(note.id) } })
  }
  const k = notesTokens(t)
  const body = useRef<RichEditorHandle>(null)
  const [initialBody] = useState(draft.body)
  const quickImages = useMemo<ImageHome>(() => ({ client: () => getClient() }), [])
  const scope = everyProject.find((p) => p.id === draft.project)?.name ?? 'Global'
  const discard = () => { save(QUICK_KEY, undefined); setNotes({ quick: false }) }
  // `.quick-note` (notes.css): 576px card, 16/20/14 padding, scope row, 18.3px title, 16.15/25.85 body, 28px foot.
  return <Dialog testId="quick-note" instant={getNav().keyboardNav} width={576} pinTop={169} radius={18} dim={0.6} onClose={() => void finish()}>
    <div onKeyDown={(e) => { if (isPrimary(e.modifiers) && e.key === 'enter') void finish() }} style={{ display: 'flex', flexDirection: 'column', paddingTop: 16, paddingLeft: 20, paddingRight: 20, paddingBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 19.5, marginBottom: 10 }}>
        <Label color={k.fg3} size={NOTES_META} lineHeight={19.5}>New note in</Label>
        <Menu testId="quick-note-scope" align="start" sideOffset={6} trigger={(open) => <PickerChip quiet size="sm" open={open} lead={<ProjectDot projectId={draft.project || null} />}>{scope}</PickerChip>}>
          {[{ id: '', name: 'Global' }, ...projects.filter((p) => !isFreeChatProject(p.id))].map((p) => <MenuItem key={p.id} id={p.id || 'global'} label={p.name} checked={draft.project === p.id} onSelect={() => update({ project: p.id })} />)}
        </Menu>
      </div>
      <input testId="quick-note-title" aria-label="Title" autoFocus placeholder="Untitled" value={draft.title} onChange={(e) => update({ title: (e.value ?? '').replace(/\s*\n\s*/g, ' ').slice(0, 300) })} onSubmit={() => body.current?.focus('start')} interceptKeys={['down']} onKeyDown={(e) => { if (e.key === 'down' && !e.modifiers?.shift) { e.preventDefault(); body.current?.focus('start') } }} style={{ height: 23.8, fontSize: 18.31, fontWeight: 650, color: t.text, backgroundColor: 'transparent', borderWidth: 0 }} />
      <div style={{ marginTop: 6, minHeight: 96 }}>
        <div style={{ display: 'flex', flexDirection: 'column', maxHeight: 310, overflow: 'scroll' }}>
          <RichEditor ref={body} testId="quick-note-body" aria-label="Note" placeholder="Write something. Type / for formatting" value={initialBody} epoch={0} variant="compact" size={16.1538} lineHeight={25.846} minHeight={77.5} images={quickImages}
            onChange={(markdown) => update({ body: markdown })} interceptKeys={['enter']}
            onKeyDown={(e) => { if (e.requestId != null && e.key === 'enter' && isPrimary(e.modifiers)) { e.preventDefault(); update({ body: body.current?.read() ?? draft.body }); void finish() } }} />
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, height: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexGrow: 1 }}><Label color={k.fg2} size={NOTES_META} lineHeight={19.5} weight={500}>Esc</Label><Label color={k.fg3} size={NOTES_META} lineHeight={19.5}>saves and closes</Label></div>
        <Button testId="quick-note-discard" variant="ghost" label="Discard" onClick={discard}>Discard</Button>
        <Button testId="quick-note-save" variant="primary" label="Save note" busy={busy} kbd="⌘↵" onClick={() => void finish()}>{busy ? 'Saving…' : 'Save note'}</Button>
      </div>
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
        const current = (await rpc(id).call('notes.get', { id })).note
        if (!current || current.deleted_at) throw new Error('This note is unavailable. Choose another note.')
        note = await rpc(id).call('notes.update', { id, expected_revision: current.revision, body: `${current.body.trimEnd()}${current.body.trim() ? '\n\n' : ''}${body}` })
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
