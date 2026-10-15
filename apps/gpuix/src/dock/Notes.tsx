import { memo, useEffect, useRef, useState } from 'react'
import { isEmptyThreadNote, noteTitle } from '@/state/notesModel'
import { relativeTime } from '@/lib/format'
import { isFreeChatProject, type NoteSummary, type Thread } from '../../../../packages/kybern-client/src/types.ts'
import { NoteEditor } from '../notes/NoteEditor.tsx'
import { getNotes, openNote, openQuickNote, recordNote, refreshNotes, rpc, setNotes, useNotes } from '../notes/store.ts'
import { load, save } from '../shell/persist.ts'
import { goPage } from '../nav/history.ts'
import { N } from '../nav/glyphs.ts'
import { useApp } from '../state.ts'
import { IconButton } from '../sidebar/rows.tsx'
import { TaskWindow, type TaskWindowEntry } from '../tasks/TaskWindow.tsx'
import { Label, useTheme } from '../ui.tsx'
import { Action, ErrorLine, Section } from './parts.tsx'

export function ScopeHeader({ thread, action }: { thread: Thread; action: React.ReactNode }) {
  const name = useApp(s => s.projects.find(p => p.id === thread.project_id)?.name)
  return <Section label={isFreeChatProject(thread.project_id) ? 'Global' : name ?? 'This project'}>{action}</Section>
}
export function NotesPane({ thread }: { thread: Thread }) {
  const notes = useNotes(s => s.notes)
  const loaded = useNotes(s => s.loaded)
  const error = useNotes(s => s.error)
  const project = isFreeChatProject(thread.project_id) ? null : thread.project_id
  const own = notes.find(n => n.thread_id === thread.id && !n.deleted_at)
  const scope = (n: NoteSummary) => project ? n.scope !== 'global' && n.project_id === project : n.scope === 'global'
  const live = notes.filter(n => !n.deleted_at && !isEmptyThreadNote(n) && n.id !== own?.id)
  const recent = (a: NoteSummary, b: NoteSummary) => b.updated_at.localeCompare(a.updated_at)
  const pinned = live.filter(n => n.pinned && (scope(n) || n.scope === 'global')).sort(recent).slice(0, 8)
  const other = live.filter(n => !n.pinned && scope(n)).sort(recent).slice(0, 50 - pinned.length)
  const entries: TaskWindowEntry[] = []
  for (const [label, items] of [['Pinned', pinned], ['Recent', other]] as const) {
    if (items.length) entries.push({ key: label, height: 32, render: () => <Section label={label} /> })
    for (const note of items) entries.push({ key: note.id, height: 48, render: () => <NoteRow note={note} /> })
  }
  const all = () => { setNotes({ selected: null, filter: project ? { kind: 'project', projectId: project } : { kind: 'global' } }); goPage('notes') }
  const quick = () => {
    const draft = load<{ title: string; body: string } | null>('kybern.notes.quick', null)
    if (!draft?.title && !draft?.body) save('kybern.notes.quick', { title: '', body: '', home: project ? { scope: 'project', projectId: project } : { scope: 'global' } })
    openQuickNote()
  }
  return <div testId="dock-notes" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>
    <ScopeHeader thread={thread} action={<IconButton icon={N.plus} label="New note" testId="dock-new-note" onClick={quick} />} />
    <Section label="This thread">{own && <Action onClick={() => openNote(own.id)}>Open in Notes ↗</Action>}</Section>
    <div style={{ paddingLeft: 8, paddingRight: 8 }}><ThreadNote key={thread.id} threadId={thread.id} noteId={own?.id} /></div>
    <ErrorLine error={error} retry={() => void refreshNotes()} />
    {!loaded ? <Section label="Loading notes…" /> : entries.length ? <TaskWindow entries={entries} testId="dock-notes-list" /> : <Section label="Other notes for this project appear here." />}
    <Action testId="dock-all-notes" onClick={all}>Show all in Notes</Action>
  </div>
}
const NoteRow = memo(function NoteRow({ note }: { note: NoteSummary }) {
  const t = useTheme()
  return <div testId={`dock-note-${note.id}`} role="button" tabIndex={0} onClick={() => openNote(note.id)} onKeyDown={e => { if (e.key === 'enter') openNote(note.id) }} style={{ display: 'flex', flexDirection: 'column', gap: 3, height: 48, padding: 6, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: t.hover } }}>
    <div style={{ display: 'flex', gap: 8, pointerEvents: 'none' }}><Label color={t.text} size={12} lineHeight={16} truncate style={{ flexGrow: 1 }}>{noteTitle(note)}</Label>{note.checklist.total > 0 && <Label color={t.textSecondary} size={11}>{`${note.checklist.done}/${note.checklist.total}`}</Label>}<Label color={t.textTertiary} size={11}>{relativeTime(note.updated_at, Date.now())}</Label></div>
    <Label color={t.textSecondary} size={11} lineHeight={14} truncate style={{ pointerEvents: 'none' }}>{note.preview.replace(/\s+/g, ' ').trim()}</Label>
  </div>
})
function ThreadNote({ threadId, noteId }: { threadId: string; noteId?: string }) {
  const t = useTheme()
  const key = `kybern.notes.threadDraft:${threadId}`
  const [body, setBody] = useState(() => load<string>(key, ''))
  const draft = useRef(body)
  const busy = useRef(false)
  const [saving, setSaving] = useState(false)
  const id = useRef(noteId)
  id.current = noteId ?? id.current
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<string>()
  const flush = async () => {
    if (!draft.current.trim() || busy.current || id.current) return
    busy.current = true; setSaving(true)
    try {
      const note = await rpc().call('notes.update', { thread_id: threadId, expected_revision: 0, body: draft.current })
      if (draft.current !== note.body) save(`kybern.notes.draft:env:note:${note.id}`, { title: note.title, body: draft.current, baseRevision: note.revision })
      id.current = note.id; save(key, undefined); setCreated(note.id); recordNote(note)
    } catch (e) {
      setError(String(e))
      if ((e as { code?: number }).code === -32004) { await refreshNotes(); const remote = getNotes().notes.find(n => n.thread_id === threadId); if (remote) save(`kybern.notes.draft:env:note:${remote.id}`, { title: remote.title, body: draft.current, baseRevision: 0 }) }
    } finally { busy.current = false; setSaving(false) }
  }
  useEffect(() => { if (!body || noteId || created) return; const timer = setTimeout(() => void flush(), 500); return () => clearTimeout(timer) }, [body, noteId, created])
  useEffect(() => () => { void flush() }, [])
  if ((noteId || created) && !saving) return <NoteEditor id={(noteId ?? created)!} compact />
  return <div style={{ display: 'flex', flexDirection: 'column', height: 200, padding: 10, borderRadius: 8, backgroundColor: t.buttonSecondary }}><textarea testId="thread-note-new" aria-label="Thread note" value={body} placeholder="Ideas, reminders, to-dos. Write Markdown here" minRows={5} maxRows={6} onChange={e => { draft.current = e.value ?? ''; setBody(draft.current); save(key, draft.current) }} onBlur={() => void flush()} theme={{ text: t.text, caret: t.text }} style={{ flexGrow: 1, width: '100%', fontSize: 12, lineHeight: 20, color: t.text, backgroundColor: t.buttonSecondary }} /><ErrorLine error={error} retry={() => void flush()} /></div>
}
