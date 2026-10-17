import { motion, useGpuix, useWindowSize, type PublicInstance } from '@gpuix/react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { ageLabel, filterChoices, filterNotes, gallerySections, noteMatchesQuery, noteTitle, type NotesFilter } from '@/state/notesModel'
import type { NoteSummary } from '../../../../packages/kybern-client/src/types.ts'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { addWindowKeyHandler } from '../nav/keys.ts'
import { Menu, MenuItem } from '../nav/overlay.tsx'
import { getNav, setNav, useNav } from '../nav/store.ts'
import { Button } from '../settings/controls.tsx'
import { useApp } from '../state.ts'
import { EASE_OUT, Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { NoteEditor } from './NoteEditor.tsx'
import { notesSearchRef } from './Header.tsx'
import { NoteThumb } from './NoteThumb.tsx'
import { NOTES_META, NOTES_UI, ProjectDot, Ring, notesTokens, useNotesTokens } from './kit.tsx'
import { deleteNote, display, getNotes, openNote, refreshNotes, searchNotes, setNotes, useNotes } from './store.ts'

let galleryEntered = false

export function NotesPage() {
  const selected = useNotes((s) => s.selected)
  const notes = useNotes((s) => s.notes)
  const loaded = useNotes((s) => s.loaded)
  useEffect(() => { if (selected && loaded && !notes.some((n) => n.id === selected)) setNotes({ selected: null }) }, [selected, loaded, notes])
  return selected && loaded && notes.some((n) => n.id === selected) ? <NoteEditor key={selected} id={selected} /> : <NotesGallery />
}

type Row = { key: string; kind: 'filters' | 'notice' | 'header' | 'cards'; label?: string; first?: boolean; notes?: NoteSummary[]; per?: number; big?: boolean; list?: boolean }

export function NotesGallery() {
  const t = useTheme()
  const k = useNotesTokens()
  const { renderer } = useGpuix()
  const size = useWindowSize({ intervalMs: 300 })
  const all = useNotes((s) => s.notes)
  const loaded = useNotes((s) => s.loaded)
  const error = useNotes((s) => s.error)
  const filter = useNotes((s) => s.filter)
  const prefs = useNotes((s) => s.display)
  const query = useNotes((s) => s.query)
  const projects = useApp((s) => s.projects)
  const projectMap = useMemo(() => Object.fromEntries(projects.map((p) => [p.id, p])), [projects])
  const [hits, setHits] = useState<{ query: string; ids: Set<string> } | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const list = useRef<PublicInstance>(null)
  const listFocus = useRef<PublicInstance>(null)
  const seen = useRef(new Set<string>())
  const keyboard = useNav((s) => s.keyboardNav)
  const [enter] = useState(() => !galleryEntered && !getNav().keyboardNav)
  useEffect(() => { galleryEntered = true }, [])
  const pageWidth = size.width - 60
  const gutter = pageWidth < 720 ? 24 : 40
  const cols = Math.max(1, Math.min(6, Math.floor((pageWidth - gutter * 2 + 20) / 268)))
  useEffect(() => {
    if (!query.trim()) return
    let live = true
    const timer = setTimeout(() => { void searchNotes(query.trim()).then((r) => { if (live) setHits({ query, ids: new Set(r.map((n) => n.id)) }) }).catch(() => {}) }, 250)
    return () => { live = false; clearTimeout(timer) }
  }, [query])
  const visible = useMemo(() => filterNotes(all, filter).filter((n) => !query || noteMatchesQuery(n, query) || (hits?.query === query && hits.ids.has(n.id))), [all, filter, query, hits])
  const sections = useMemo(() => gallerySections(visible, { ...prefs, projects: projectMap, projectOrder: [], flat: !!query || filter.kind === 'deleted' }), [visible, prefs, projectMap, query, filter.kind])
  const rows = useMemo(() => {
    const out: Row[] = [{ key: 'filters', kind: 'filters' }]
    if (filter.kind === 'deleted' && visible.length) out.push({ key: 'notice', kind: 'notice', label: 'Notes here are deleted forever after 30 days. Right-click a note to restore it.' })
    if (query.trim() && visible.length) out.push({ key: 'notice', kind: 'notice', label: `${visible.length === 1 ? '1 note matches' : `${visible.length} notes match`} “${query.trim()}”` })
    sections.forEach((section, index) => {
      const per = prefs.layout === 'list' ? 1 : section.pinned && cols >= 4 ? Math.round(cols / 2) : cols
      if (section.label) out.push({ key: `h:${section.key}`, kind: 'header', label: section.label, first: index === 0, list: prefs.layout === 'list' })
      for (let i = 0; i < section.notes.length; i += per) out.push({ key: section.notes[i]!.id, kind: 'cards', notes: section.notes.slice(i, i + per), per, big: section.pinned, list: prefs.layout === 'list' })
    })
    return out
  }, [sections, prefs.layout, cols, filter.kind, query, visible])
  const order = rows.flatMap((r) => r.notes ?? [])
  const choices = filterChoices(all, projectMap, [])
  const pickFilter = (next: NotesFilter) => { setNotes({ filter: next }); setActive(null) }
  const focus = (id: string) => {
    setActive(id)
    const index = rows.findIndex((row) => row.notes?.some((n) => n.id === id))
    if (list.current && index >= 0) renderer?.scrollToItem?.(list.current.id, index)
  }
  const keys = (key: string) => {
    const at = Math.max(0, order.findIndex((n) => n.id === active))
    const row = rows.find((r) => r.notes?.some((n) => n.id === active))
    const stride = row?.per ?? cols
    const next = key === 'home' ? 0 : key === 'end' ? order.length - 1 : key === 'down' ? at + stride : key === 'up' ? at - stride : key === 'right' ? at + 1 : key === 'left' ? at - 1 : null
    if (next !== null) { setNav({ keyboardNav: true }); const note = order[Math.max(0, Math.min(order.length - 1, next))]; if (note) focus(note.id) }
    if (key === 'enter' && order[at]) { setNav({ keyboardNav: true }); openNote(order[at]!.id) }
    if ((key === 'backspace' || key === 'delete') && active) {
      const note = order.find((n) => n.id === active)
      if (note && !note.deleted_at) { const next = order[at + 1] ?? order[at - 1]; void deleteNote(note.id); if (next) focus(next.id) }
    }
  }
  useEffect(() => addWindowKeyHandler((e) => {
    if (getNav().paletteOpen || getNav().settingsOpen || getNotes().quick || getNotes().capture) return
    if (e.modifiers?.cmd && !e.modifiers.shift && e.key === 'f') { if (notesSearchRef.current) renderer?.focusElement?.(notesSearchRef.current.id); return true }
  }), [renderer])

  const chip = (value: NotesFilter['kind'], label: string, dot?: string | null) => {
    const selected = filter.kind === value && (value !== 'project')
    return <Chip key={`${value}:${label}`} testId={`notes-filter-${value}`} label={label} selected={selected} dot={dot} onClick={() => pickFilter({ kind: value } as NotesFilter)} />
  }
  const filters = <div style={{ display: 'flex', alignItems: 'center', gap: 4, height: 28, marginTop: 20 }}>
    {chip('all', 'All')}
    {chip('global', 'Global')}
    {projects.filter((p) => choices.projects.some((c) => c.id === p.id)).map((p) => <Chip key={p.id} label={p.name} selected={filter.kind === 'project' && filter.projectId === p.id} dot={p.id} onClick={() => pickFilter({ kind: 'project', projectId: p.id })} />)}
    {choices.threads > 0 && chip('threads', 'Threads')}
    <Menu testId="notes-projects" sideOffset={6} trigger={() => <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 8, cursor: 'pointer', hover: { backgroundColor: k.hover } }}><Icon source={N.plus} size={14} color={k.fg3} /></div>}>
      {projects.map((p) => <MenuItem key={p.id} id={p.id} label={p.name} onSelect={() => pickFilter({ kind: 'project', projectId: p.id })} />)}
    </Menu>
    {filter.kind === 'deleted' && <Chip label="Recently deleted" selected onClick={() => pickFilter({ kind: 'deleted' })} />}
    <div style={{ flexGrow: 1 }} />
    {choices.deleted > 0 && filter.kind !== 'deleted' && <Chip testId="notes-filter-deleted" label="Recently deleted" quiet onClick={() => pickFilter({ kind: 'deleted' })} />}
  </div>
  return <div testId="page-notes" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>
    {error && <div style={{ display: 'flex', gap: 10, padding: 24 }}><Label color={t.red}>{error}</Label><Button onClick={() => void refreshNotes()}>Try again</Button></div>}
    {!loaded ? <Empty title="Loading notes…" /> : <div ref={listFocus} tabIndex={0} onKeyDown={(e) => keys(e.key ?? '')} style={{ display: 'flex', flexGrow: 1, minHeight: 0 }}><virtual-list ref={list} testId="notes-gallery" style={{ flexGrow: 1, minHeight: 0 }}>
      {rows.map((row, index) => <div key={row.key} style={{ paddingLeft: gutter, paddingRight: gutter }}>
        {row.kind === 'filters' ? filters
          : row.kind === 'notice' ? <div style={{ paddingTop: 16, paddingBottom: 12 }}><Label color={k.fg3} size={NOTES_META} lineHeight={18}>{row.label!}</Label></div>
          : row.kind === 'header' ? <div style={{ paddingTop: row.first || row.list ? 24 : 4, paddingBottom: 10 }}><Label color={k.fg} size={NOTES_UI} lineHeight={18} weight={600}>{row.label!}</Label></div>
          : <div style={{ display: 'flex', gap: row.list ? 0 : 20, paddingBottom: row.list ? 0 : 24 }}>{row.notes!.map((note, column) => <NoteCard key={note.id} note={note} big={!!row.big} list={!!row.list} scope={note.scope === 'global' ? 'Global' : projectMap[note.project_id ?? '']?.name ?? 'Chats'} projectId={note.scope === 'global' ? null : note.project_id ?? null} active={active === note.id && keyboard} enter={enter && !keyboard && index < 5 && !seen.current.has(note.id)} index={index + column} onSeen={() => seen.current.add(note.id)} onFocus={() => setActive(note.id)} />)}{Array.from({ length: row.per! - row.notes!.length }, (_, i) => <div key={i} style={{ flexGrow: 1, flexBasis: 0 }} />)}</div>}
      </div>)}
      {loaded && !visible.length && <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 320, paddingTop: 48, paddingBottom: 48 }}>
        <Label color={k.fg} size={17} lineHeight={23} weight={600}>{query ? `No notes match “${query.trim()}”` : emptyTitle(filter, projectMap)}</Label>
        <Label color={k.fg3} size={NOTES_UI} lineHeight={20}>{query ? 'Search looks at titles and text.' : emptyDetail(filter)}</Label>
      </div>}
    </virtual-list></div>}
    {prefs.hints && <Hints list={prefs.layout === 'list'} />}
  </div>
}

function emptyTitle(filter: NotesFilter, projects: Record<string, { name: string }>): string {
  switch (filter.kind) {
    case 'global': return 'No global notes yet'
    case 'project': return `No notes in ${projects[filter.projectId]?.name ?? 'this project'}`
    case 'threads': return 'No thread notes yet'
    case 'deleted': return 'Nothing in Recently deleted'
    default: return 'No notes yet'
  }
}
function emptyDetail(filter: NotesFilter): string {
  switch (filter.kind) {
    case 'global': return 'Global notes belong to no project, so you can find them from every project.'
    case 'project': return 'Notes for this project show up here, with its threads’ notes.'
    case 'threads': return 'Write in a thread’s Notes panel and the note shows up here.'
    case 'deleted': return 'Deleted notes stay here for 30 days.'
    default: return 'Notes you write show up here.'
  }
}

/** `.notes-chip`: 28px, radius 8, 11px side padding; the selected one is a fill, not an underline. */
function Chip({ label, selected, dot, quiet, icon, onClick, testId }: { label: string; selected?: boolean; dot?: string | null; quiet?: boolean; icon?: string; onClick: () => void; testId?: string }) {
  const k = useNotesTokens()
  return <div testId={testId} tabIndex={0} onClick={onClick} onKeyDown={(e) => { if (e.key === 'enter') onClick() }} style={{ display: 'flex', alignItems: 'center', gap: 7, height: 28, flexShrink: 0, paddingLeft: 11, paddingRight: 11, borderRadius: 8, cursor: 'pointer', backgroundColor: selected ? k.sel : undefined, hover: { backgroundColor: selected ? k.sel : k.hover } }}>
    {dot !== undefined && dot !== null && <ProjectDot projectId={dot} />}
    {icon && <Icon source={icon} size={13} color={k.fg3} />}
    <Label color={selected ? k.fg : quiet ? k.fg3 : k.fg2} size={NOTES_UI} lineHeight={21} weight={selected ? 500 : undefined}>{label}</Label>
  </div>
}

/** `.notes-hints`: one quiet line, no key caps. */
function Hints({ list }: { list: boolean }) {
  const k = useNotesTokens()
  const item = (key: string, text: string) => <div key={text} style={{ display: 'flex', gap: 5 }}><Label color={k.fg2} size={NOTES_META} weight={500}>{key}</Label><Label color={k.fg3} size={NOTES_META}>{text}</Label></div>
  return <div style={{ display: 'flex', alignItems: 'center', gap: 20, height: 36, paddingLeft: 20, paddingRight: 20, flexShrink: 0 }}>
    {item(list ? '↑↓' : '←→', 'Move')}{item('↵', 'Open')}{item('⌫', 'Delete')}{item('⌘N', 'New note')}{item('⌘F', 'Search')}
    <div style={{ flexGrow: 1 }} />
    <div onClick={() => display({ hints: false })} style={{ cursor: 'pointer' }}><Label color={k.fg4} size={NOTES_META}>Hide hints</Label></div>
  </div>
}

const NoteCard = memo(function NoteCard({ note, big, list, scope, projectId, active, enter, index, onSeen, onFocus }: { note: NoteSummary; big: boolean; list: boolean; scope: string; projectId: string | null; active: boolean; enter: boolean; index: number; onSeen: () => void; onFocus: () => void }) {
  const t = useTheme()
  const k = notesTokens(t)
  const [play] = useState(enter)
  const [hover, setHover] = useState(false)
  useEffect(() => { onSeen() }, [])
  const { done, total } = note.checklist
  const age = ageLabel(note.updated_at)
  const motionProps = { initial: play ? { opacity: 0, top: REDUCED_MOTION ? 0 : 6 } : (false as const), animate: { opacity: 1, top: 0 }, transition: { duration: play ? 0.17 : 0, delay: play ? Math.min(index, 3) * 0.025 : 0, ease: EASE_OUT } }
  if (list) {
    return <motion.div {...motionProps} style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0, position: 'relative' }}>
      <div testId={`note-card-${note.id}`} tabIndex={0} onFocus={onFocus} onClick={() => openNote(note.id)} onKeyDown={(e) => { if (e.key === 'enter') openNote(note.id) }} style={{ display: 'flex', alignItems: 'center', gap: 16, height: 40, marginLeft: -12, marginRight: -12, paddingLeft: 12, paddingRight: 12, borderRadius: 8, cursor: 'pointer', backgroundColor: active ? k.sel : undefined, hover: { backgroundColor: k.hover } }}>
        <div style={{ display: 'flex', minWidth: 80, maxWidth: '42%', flexShrink: 0 }}><Label color={k.fg} size={NOTES_UI} lineHeight={21} truncate>{noteTitle(note)}</Label></div>
        <div style={{ display: 'flex', flexGrow: 1, minWidth: 0 }}><Label color={k.fg3} size={NOTES_UI} lineHeight={21} truncate>{note.preview.trim()}</Label></div>
        {note.deleted_at ? null : <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: 148, flexShrink: 0 }}><ProjectDot projectId={projectId} /><Label color={k.fg2} size={NOTES_META} truncate>{scope}</Label></div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, width: 48, flexShrink: 0 }}>{total > 0 && <><Ring done={done} total={total} color={k.fg3} /><Label color={k.fg3} size={NOTES_META}>{`${done}/${total}`}</Label></>}</div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', width: 92, flexShrink: 0 }}><Label color={k.fg3} size={NOTES_META}>{age}</Label></div>
        </>}
      </div>
    </motion.div>
  }
  return <motion.div {...motionProps} style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, flexBasis: 0, minWidth: 0, position: 'relative' }}>
    <div testId={`note-card-${note.id}`} tabIndex={0} onFocus={onFocus} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onClick={() => openNote(note.id)} onKeyDown={(e) => { if (e.key === 'enter') openNote(note.id) }} style={{ display: 'flex', flexDirection: 'column', borderRadius: 12, cursor: 'pointer', marginLeft: 0 }}>
      <NoteThumb note={note} big={big} active={active} lift={hover} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, paddingTop: 10, paddingLeft: 2, paddingRight: 2, pointerEvents: 'none' }}>
        <Label color={k.fg} size={NOTES_UI} lineHeight={18} weight={600} truncate>{noteTitle(note)}</Label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <Label color={k.fg3} size={NOTES_META} lineHeight={16} style={{ flexShrink: 0 }}>{age}</Label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flexShrink: 1 }}><ProjectDot projectId={projectId} /><Label color={k.fg3} size={NOTES_META} lineHeight={16} truncate>{scope}</Label></div>
          <div style={{ flexGrow: 1 }} />
          {total > 0 && <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}><Ring done={done} total={total} color={k.fg3} /><Label color={k.fg3} size={NOTES_META} lineHeight={16}>{`${done}/${total}`}</Label></div>}
        </div>
      </div>
    </div>
  </motion.div>
})

export function Empty({ title, detail }: { title: string; detail?: string }) { const t = useTheme(); return <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flexGrow: 1, gap: 10 }}><Icon source={N.note} size={28} color={t.iconTertiary} /><Label color={t.text} size={17}>{title}</Label>{detail && <Label color={t.textSecondary}>{detail}</Label>}</div> }
