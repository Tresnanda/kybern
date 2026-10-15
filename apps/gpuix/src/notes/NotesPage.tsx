import { motion, useGpuix, useWindowSize, type PublicInstance } from '@gpuix/react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { ageLabel, filterChoices, filterNotes, gallerySections, noteMatchesQuery, noteTitle, type NotesFilter } from '@/state/notesModel'
import type { NoteSummary } from '../../../../packages/kybern-client/src/types.ts'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { Menu, MenuItem } from '../nav/overlay.tsx'
import { addWindowKeyHandler } from '../nav/keys.ts'
import { getNav, setNav, useNav } from '../nav/store.ts'
import { Button, TextField } from '../settings/controls.tsx'
import { useApp } from '../state.ts'
import { EASE_OUT, Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { deleteNote, display, getNotes, newNote, openNote, refreshNotes, rpc, setNotes, useNotes } from './store.ts'
import { NoteEditor } from './NoteEditor.tsx'

let galleryEntered = false

export function NotesPage() {
  const selected = useNotes((s) => s.selected)
  const notes = useNotes((s) => s.notes)
  const loaded = useNotes((s) => s.loaded)
  useEffect(() => { if (selected && loaded && !notes.some((n) => n.id === selected)) setNotes({ selected: null }) }, [selected, loaded, notes])
  return selected && (!loaded || notes.some((n) => n.id === selected)) ? <NoteEditor key={selected} id={selected} /> : <NotesGallery />
}

export function NotesGallery() {
  const t = useTheme()
  const { renderer } = useGpuix()
  const size = useWindowSize({ intervalMs: 300 })
  const all = useNotes((s) => s.notes)
  const loaded = useNotes((s) => s.loaded)
  const error = useNotes((s) => s.error)
  const filter = useNotes((s) => s.filter)
  const prefs = useNotes((s) => s.display)
  const projects = useApp((s) => s.projects)
  const projectMap = useMemo(() => Object.fromEntries(projects.map((p) => [p.id, p])), [projects])
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<{ query: string; ids: Set<string> } | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const search = useRef<PublicInstance>(null)
  const list = useRef<PublicInstance>(null)
  const listFocus = useRef<PublicInstance>(null)
  const seen = useRef(new Set<string>())
  const keyboard = useNav((s) => s.keyboardNav)
  const [enter] = useState(() => !galleryEntered && !getNav().keyboardNav)
  useEffect(() => { galleryEntered = true }, [])
  const gutter = size.width < 780 ? 24 : 40
  const cols = Math.max(1, Math.min(6, Math.floor((size.width - 62 - gutter * 2 + 20) / 268)))
  useEffect(() => {
    if (!query.trim()) return
    let live = true
    const timer = setTimeout(() => { void rpc().call('notes.search', { query: query.trim(), limit: 200 }).then((r) => { if (live) setHits({ query, ids: new Set(r.results.map((n) => n.id)) }) }).catch(() => {}) }, 250)
    return () => { live = false; clearTimeout(timer) }
  }, [query])
  const visible = useMemo(() => filterNotes(all, filter).filter((n) => !query || noteMatchesQuery(n, query) || (hits?.query === query && hits.ids.has(n.id))), [all, filter, query, hits])
  const sections = useMemo(() => gallerySections(visible, { ...prefs, projects: projectMap, projectOrder: [], flat: !!query || filter.kind === 'deleted' }), [visible, prefs, projectMap, query, filter.kind])
  const rows = useMemo(() => sections.flatMap((section) => {
    const per = prefs.layout === 'list' ? 1 : section.pinned && cols >= 4 ? Math.round(cols / 2) : cols
    const entries: Array<{ key: string; label?: string; notes?: NoteSummary[]; per?: number; big?: boolean }> = []
    if (section.label) entries.push({ key: `h:${section.key}`, label: section.label })
    for (let i = 0; i < section.notes.length; i += per) entries.push({ key: section.notes[i]!.id, notes: section.notes.slice(i, i + per), per, big: section.pinned })
    return entries
  }), [sections, prefs.layout, cols])
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
    if (e.modifiers?.cmd && !e.modifiers.shift && e.key === 'f') { renderer?.focusElement?.(search.current!.id); return true }
  }), [renderer])
  return <div testId="page-notes" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 44, paddingLeft: 16, paddingRight: 16, flexShrink: 0 }}>
      <Label color={t.text} weight={500} style={{ flexGrow: 1 }}>Notes</Label>
      <TextField ref={search} testId="notes-search" label="Search notes" placeholder="Search notes" value={query} onChange={setQuery} width={190} onKeyDown={(e) => { if (e.key === 'down' && order[0]) { focus(order[0].id); renderer?.focusElement?.(listFocus.current!.id) } }} />
      <Menu testId="notes-display" align="end" trigger={() => <div style={{ padding: 6 }}><Label color={t.textSecondary}>Display</Label></div>}>
        {(['gallery', 'list'] as const).map((value) => <MenuItem key={value} id={value} testId={`notes-layout-${value}`} label={value === 'gallery' ? 'Gallery' : 'List'} checked={prefs.layout === value} onSelect={() => display({ layout: value })} />)}
        {(['none', 'date', 'project'] as const).map((value) => <MenuItem key={value} id={value} label={`Group: ${value === 'none' ? 'None' : value === 'date' ? 'Date' : 'Project'}`} checked={prefs.group === value} onSelect={() => display({ group: value })} />)}
        {(['edited', 'created', 'title'] as const).map((value) => <MenuItem key={value} id={value} label={`Sort: ${value === 'edited' ? 'Last edited' : value === 'created' ? 'Created' : 'Title'}`} checked={prefs.sort === value} onSelect={() => display({ sort: value })} />)}
        <MenuItem id="hints" label="Keyboard hints" checked={prefs.hints} onSelect={() => display({ hints: !prefs.hints })} />
      </Menu>
      <Button testId="notes-new" onClick={() => void newNote()}>New note</Button>
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, paddingLeft: gutter, paddingRight: gutter, height: 48, flexShrink: 0 }}>
      {([['all', 'All'], ['global', 'Global'], ['threads', 'Threads'], ['deleted', 'Recently deleted']] as const).filter(([value]) => value !== 'threads' || choices.threads).map(([value, label]) => <div key={value} testId={`notes-filter-${value}`} tabIndex={0} onClick={() => pickFilter({ kind: value })} onKeyDown={(e) => { if (e.key === 'enter') pickFilter({ kind: value }) }} style={{ paddingTop: 8, paddingBottom: 8, cursor: 'pointer', borderBottomWidth: filter.kind === value ? 1 : 0, borderColor: t.text }}><Label size={13} color={filter.kind === value ? t.text : t.textSecondary}>{label}</Label></div>)}
      <Menu testId="notes-projects" trigger={() => <Label color={filter.kind === 'project' ? t.text : t.textSecondary}>{filter.kind === 'project' ? projectMap[filter.projectId]?.name ?? 'Project' : 'Projects'}</Label>}>
        {projects.map((p) => <MenuItem key={p.id} id={p.id} label={p.name} onSelect={() => pickFilter({ kind: 'project', projectId: p.id })} />)}
      </Menu>
    </div>
    {filter.kind === 'deleted' && <div style={{ paddingLeft: gutter, paddingBottom: 12 }}><Label color={t.textSecondary} size={12}>Notes here are deleted forever after 30 days. Open a note to restore it.</Label></div>}
    {error && <div style={{ display: 'flex', gap: 10, padding: 24 }}><Label color={t.red}>{error}</Label><Button onClick={() => void refreshNotes()}>Try again</Button></div>}
    {!loaded ? <Empty title="Loading notes…" /> : !visible.length ? <Empty title={query ? 'No matching notes' : all.length ? 'No notes here' : 'A place for your thoughts'} detail={query ? 'Try another title or a phrase from the note.' : 'Keep ideas, plans, and things worth remembering.'} /> : <div ref={listFocus} tabIndex={0} onKeyDown={(e) => keys(e.key ?? '')} style={{ display: 'flex', flexGrow: 1, minHeight: 0 }}><virtual-list ref={list} testId="notes-gallery" style={{ flexGrow: 1, minHeight: 0 }}>
      {rows.map((row, index) => <div key={row.key} style={{ paddingLeft: gutter, paddingRight: gutter, paddingBottom: row.label ? 12 : prefs.layout === 'list' ? 0 : 24, paddingTop: row.label ? 16 : 0 }}>
        {row.label ? <Label color={t.textSecondary} size={12} weight={500}>{row.label}</Label> : <div style={{ display: 'flex', gap: 20 }}>{row.notes!.map((note, column) => <NoteCard key={note.id} note={note} big={!!row.big} list={prefs.layout === 'list'} width={prefs.layout === 'list' ? '100%' : `${100 / row.per!}%`} scope={note.scope === 'global' ? 'Global' : projectMap[note.project_id ?? '']?.name ?? 'Chats'} active={active === note.id} enter={enter && !keyboard && index < 5 && !seen.current.has(note.id)} index={index + column} onSeen={() => seen.current.add(note.id)} onFocus={() => setActive(note.id)} />)}{Array.from({ length: row.per! - row.notes!.length }, (_, i) => <div key={i} style={{ flexGrow: 1, flexBasis: 0 }} />)}</div>}
      </div>)}
    </virtual-list></div>}
    {prefs.hints && <div style={{ display: 'flex', justifyContent: 'center', padding: 12 }}><Label color={t.textSecondary} size={11}>↑ ↓ ← → Navigate     ↵ Open     ⌘ N New note     ⌘ F Search</Label></div>}
  </div>
}
const NoteCard = memo(function NoteCard({ note, big, list, scope, active, enter, index, onSeen, onFocus }: { note: NoteSummary; big: boolean; list: boolean; width: string; scope: string; active: boolean; enter: boolean; index: number; onSeen: () => void; onFocus: () => void }) {
  const t = useTheme()
  const [play] = useState(enter)
  useEffect(() => { onSeen() }, [])
  return <motion.div initial={play ? { opacity: 0, top: REDUCED_MOTION ? 0 : 6 } : false} animate={{ opacity: 1, top: 0 }} transition={{ duration: play ? 0.17 : 0, delay: play ? Math.min(index, 3) * 0.025 : 0, ease: EASE_OUT }} style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, flexBasis: 0, minWidth: 0, position: 'relative' }}>
    <div testId={`note-card-${note.id}`} tabIndex={0} onFocus={onFocus} onClick={() => openNote(note.id)} onKeyDown={(e) => { if (e.key === 'enter') openNote(note.id) }} style={{ display: 'flex', flexDirection: list ? 'row' : 'column', gap: list ? 10 : 8, alignItems: list ? 'center' : 'stretch', height: list ? 40 : undefined, borderRadius: 12, backgroundColor: active ? t.hover : undefined, cursor: 'pointer', hover: { backgroundColor: t.hover } }}>
      {list ? <Icon source={note.pinned ? N.pin : N.note} size={16} color={t.iconSecondary} /> : <div style={{ height: big ? 184 : 156, borderRadius: 12, backgroundColor: t.buttonSecondary, borderWidth: 0.5, borderColor: active ? t.textSecondary : t.border, padding: 22, overflow: 'hidden', pointerEvents: 'none' }}><Label color={t.textSecondary} size={big ? 12 : 11} lineHeight={19}>{note.preview || 'Start writing…'}</Label></div>}
      <div style={{ display: 'flex', flexDirection: list ? 'row' : 'column', flexGrow: 1, minWidth: 0, gap: list ? 16 : 3, paddingLeft: list ? 0 : 2, pointerEvents: 'none' }}>
        <Label color={t.text} weight={500} size={13} truncate style={{ flexGrow: 1 }}>{`${note.pinned && !list ? '⌖ ' : ''}${noteTitle(note)}`}</Label>
        <Label color={t.textSecondary} size={11} truncate>{`${scope} · ${ageLabel(note.updated_at)}${note.checklist.total ? ` · ${note.checklist.done}/${note.checklist.total}` : ''}`}</Label>
      </div>
    </div>
  </motion.div>
})
export function Empty({ title, detail }: { title: string; detail?: string }) { const t = useTheme(); return <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flexGrow: 1, gap: 10 }}><Icon source={N.note} size={28} color={t.iconTertiary} /><Label color={t.text} size={17}>{title}</Label>{detail && <Label color={t.textSecondary}>{detail}</Label>}</div> }
