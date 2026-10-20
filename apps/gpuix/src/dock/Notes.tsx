import { memo, useEffect, useRef, useState } from 'react'
import { isEmptyThreadNote, noteTitle } from '@/state/notesModel'
import { relativeTime } from '@/lib/format'
import { isFreeChatProject, type NoteSummary, type Thread } from '../../../../packages/kybern-client/src/types.ts'
import { ProjectDot, Ring } from '../notes/kit.tsx'
import { muted } from '../nav/overlay.tsx'
import { DecoratedTextarea } from '../native/decorated-input.tsx'
import { markdownInputDecorations, noteInputMarkColors } from '../native/input-marks.ts'
import { NoteEditor } from '../notes/NoteEditor.tsx'
import { getNotes, openNote, openQuickNote, recordNote, refreshNotes, rpc, setNotes, useNotes } from '../notes/store.ts'
import { load, save } from '../shell/persist.ts'
import { goPage } from '../nav/history.ts'
import { N } from '../nav/glyphs.ts'
import { ArrowUpRight01Icon } from '@hugeicons/core-free-icons'
import { glyph } from '../icons.tsx'
const ARROW_UP_RIGHT = glyph(ArrowUpRight01Icon)
import { useApp } from '../state.ts'
import { IconButton } from '../sidebar/rows.tsx'
import { TaskWindow, type TaskWindowEntry } from '../tasks/TaskWindow.tsx'
import { ink, Label, useTheme } from '../ui.tsx'
import { Action, ErrorLine, Section } from './parts.tsx'
import { pressTransform } from '../motion/press.ts'

export function ScopeHeader({ thread, action }: { thread: Thread; action: React.ReactNode }) {
  const name = useApp(s => s.projects.find(p => p.id === thread.project_id)?.name)
  const t = useTheme()
  return <div style={{ display: 'flex', alignItems: 'center', height: 36, flexShrink: 0, gap: 8, paddingLeft: 14, paddingRight: 6 }}><div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 14 }}><ProjectDot projectId={isFreeChatProject(thread.project_id) ? null : thread.project_id} /></div><Label color={ink(t, 0.85)} size={14} weight={500} truncate style={{ flexGrow: 1 }}>{isFreeChatProject(thread.project_id) ? 'Global' : name ?? 'Project'}</Label>{action}</div>
}
export function NotesPane({ thread }: { thread: Thread }) {
  const notes = useNotes(s => s.notes)
  const loaded = useNotes(s => s.loaded)
  const error = useNotes(s => s.error)
  const project = isFreeChatProject(thread.project_id) ? null : thread.project_id
  const projectName = useApp(s => s.projects.find(p => p.id === thread.project_id)?.name)
  const own = notes.find(n => n.thread_id === thread.id && !n.deleted_at)
  const scope = (n: NoteSummary) => project ? n.scope !== 'global' && n.project_id === project : n.scope === 'global'
  const live = notes.filter(n => !n.deleted_at && !isEmptyThreadNote(n) && n.id !== own?.id)
  const recent = (a: NoteSummary, b: NoteSummary) => b.updated_at.localeCompare(a.updated_at)
  const pinned = live.filter(n => n.pinned && (scope(n) || n.scope === 'global')).sort(recent).slice(0, 8)
  const other = live.filter(n => !n.pinned && scope(n)).sort(recent).slice(0, 50 - pinned.length)
  const entries: TaskWindowEntry[] = []
  for (const [label, items] of [['Pinned', pinned], ['Recent', other]] as const) {
    if (items.length) entries.push({ key: label, height: label === 'Recent' && pinned.length ? 36 : 28, render: () => <div style={{ paddingTop: label === 'Recent' && pinned.length ? 8 : 0 }}><DockSection label={label} /></div> })
    for (const note of items) entries.push({ key: note.id, height: 55, render: () => <NoteRow note={note} /> })
  }
  const all = () => { setNotes({ selected: null, filter: project ? { kind: 'project', projectId: project } : { kind: 'global' } }); goPage('notes') }
  const quick = () => {
    const draft = load<{ title: string; body: string } | null>('kybern.notes.quick', null)
    if (!draft?.title && !draft?.body) save('kybern.notes.quick', { title: '', body: '', home: project ? { scope: 'project', projectId: project } : { scope: 'global' } })
    openQuickNote()
  }
  entries.push({ key: 'footer', height: 40, render: () => <DockFooter testId="dock-all-notes" onClick={all}>Show all in Notes</DockFooter> })
  return <div testId="dock-notes" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>
    <ScopeHeader thread={thread} action={<IconButton icon={N.plus} label="New note" testId="dock-new-note" onClick={quick} />} />
    <DockSection label="This thread">{own && !isEmptyThreadNote(own) && <IconButton icon={ARROW_UP_RIGHT} size={20} glyph={14} label="Open in Notes" tooltip="Open in Notes" tooltipSide="top" onClick={() => openNote(own.id)} />}</DockSection>
    <div style={{ paddingLeft: 8, paddingRight: 8, paddingBottom: 16 }}><ThreadNote key={thread.id} threadId={thread.id} noteId={own?.id} /></div>
    <ErrorLine error={error} retry={() => void refreshNotes()} />
    {!loaded ? <Section label="Loading notes…" /> : entries.length ? <TaskWindow entries={entries} testId="dock-notes-list" /> : <Section label={`Other notes for ${project ? projectName ?? 'this project' : 'Global'} appear here.`} />}
  </div>
}
const NoteRow = memo(function NoteRow({ note }: { note: NoteSummary }) {
  const t = useTheme()
  return <div testId={`dock-note-${note.id}`} role="button" tabIndex={0} onClick={() => openNote(note.id)} onKeyDown={e => { if (e.key === 'enter') openNote(note.id) }} style={{ display: 'flex', flexDirection: 'column', gap: 2, height: 54, paddingTop: 6, paddingBottom: 6, paddingLeft: 8, paddingRight: 8, marginLeft: 6, marginRight: 6, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: t.hover } }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, pointerEvents: 'none' }}><Label color={t.text} size={14} lineHeight={21} truncate style={{ flexGrow: 1 }}>{noteTitle(note)}</Label>{note.checklist.total > 0 && <Ring done={note.checklist.done} total={note.checklist.total} color={muted(t, 0.55)} />}<Label color={muted(t, 0.55)} size={13}>{relativeTime(note.updated_at, Date.now())}</Label></div>
    <Label color={muted(t, 0.6)} size={13} lineHeight={19.5} truncate style={{ pointerEvents: 'none' }}>{note.preview.replace(/\s+/g, ' ').trim()}</Label>
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
  // The textarea's own placeholder has a fixed colour; draw the desktop's (muted 14px) over the empty field.
  return <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', height: 96, paddingLeft: 10, paddingRight: 10, paddingTop: 8, paddingBottom: 8, borderRadius: 10, backgroundColor: ink(t, 0.05) }}>
    {!body && <div style={{ position: 'absolute', left: 10, top: 8, right: 10, pointerEvents: 'none' }}><Label color={muted(t, 0.45)} size={14} lineHeight={20} truncate>Ideas, reminders, to-dos. Type / for formatting</Label></div>}
    <DecoratedTextarea decorations={markdownInputDecorations(body, noteInputMarkColors(t))} testId="thread-note-new" aria-label="Thread note" value={body} minRows={3} maxRows={6} onChange={e => { draft.current = e.value ?? ''; setBody(draft.current); save(key, draft.current) }} onBlur={() => void flush()} theme={{ text: t.text, caret: t.text }} style={{ flexGrow: 1, width: '100%', fontSize: 14, lineHeight: 20, color: t.text, backgroundColor: 'transparent' }} /><ErrorLine error={error} retry={() => void flush()} /></div>
}

export function DockSection({ label, count, children }: { label: string; count?: number; children?: React.ReactNode }) {
  const t = useTheme()
  return <div style={{ display: 'flex', alignItems: 'center', height: 28, flexShrink: 0, gap: 6, paddingLeft: 14, paddingRight: 6 }}><Label color={muted(t, 0.58)} size={13}>{label}</Label>{count !== undefined && <Label color={muted(t, 0.4)} size={13}>{String(count)}</Label>}<div style={{ flexGrow: 1 }} />{children}</div>
}
export function DockFooter({ children, testId, onClick }: { children: string; testId: string; onClick: () => void }) {
  const t = useTheme()
  // `DockFooterLink`: a `press` button.
  return <div testId={testId} role="button" tabIndex={0} onClick={onClick} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') onClick() }} paintTransform={pressTransform()} style={{ display: 'flex', alignItems: 'center', height: 28, marginLeft: 6, marginRight: 6, marginTop: 4, marginBottom: 8, paddingLeft: 8, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: t.hover } }}><Label color={muted(t, 0.7)} size={13}>{children}</Label></div>
}
