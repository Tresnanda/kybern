import { useGpuix, useWindowSize, type PublicInstance } from '@gpuix/react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { ageLabel, filterChoices, filterNotes, gallerySections, noteMatchesQuery, noteTitle, type NotesFilter } from '@/state/notesModel'
import type { NoteSummary } from '../../../../packages/kybern-client/src/types.ts'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { addWindowKeyHandler } from '../nav/keys.ts'
import { Menu, MenuItem } from '../nav/overlay.tsx'
import { getNav, setNav, useNav } from '../nav/store.ts'
import { Button } from '../kit/Button.tsx'
import { IconButton } from '../kit/IconButton.tsx'
import { PickerChip } from '../kit/PickerChip.tsx'
import { useApp } from '../state.ts'
import { inSpace } from '../../../../packages/kybern-client/src/spaces.ts'
import { useCurrentSpaceId, useSpaceProjects } from '../spaces/current.ts'
import { Label, useTheme } from '../ui.tsx'
import { NoteEditor } from './NoteEditor.tsx'
import { notesSearchRef } from './Header.tsx'
import { NoteThumb } from './NoteThumb.tsx'
import { cardIn, cardLeave, useFreshNotes, useLeavingNotes } from './motion.ts'
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
  const allNotes = useNotes((s) => s.notes)
  const loaded = useNotes((s) => s.loaded)
  const error = useNotes((s) => s.error)
  const filter = useNotes((s) => s.filter)
  const prefs = useNotes((s) => s.display)
  const query = useNotes((s) => s.query)
  const everyProject = useApp((s) => s.projects)
  const projects = useSpaceProjects()
  const spaceId = useCurrentSpaceId()
  // The name map stays complete; notes of other spaces' projects are hidden, global notes stay.
  const projectMap = useMemo(() => Object.fromEntries(everyProject.map((p) => [p.id, p])), [everyProject])
  const all = useMemo(() => allNotes.filter((note) => inSpace(note.project_id, everyProject, spaceId)), [allNotes, everyProject, spaceId])
  const [hits, setHits] = useState<{ query: string; ids: Set<string> } | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const list = useRef<PublicInstance>(null)
  const listFocus = useRef<PublicInstance>(null)
  const seen = useRef(new Set<string>())
  const keyboard = useNav((s) => s.keyboardNav)
  // Cards enter on the first gallery open of the session and when a pointer picks another filter; never for typing, keyboard or sorting.
  const [enterGen, setEnterGen] = useState(() => (!galleryEntered && !getNav().keyboardNav ? 1 : 0))
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
  const matches = useMemo(() => filterNotes(all, filter).filter((n) => !query || noteMatchesQuery(n, query) || (hits?.query === query && hits.ids.has(n.id))), [all, filter, query, hits])
  // A note deleted from its menu keeps its card for the exit (`useLeavingNotes`); a keyboard delete removes it at once.
  const { list: visible, leaving, gone } = useLeavingNotes(matches)
  const fresh = useFreshNotes(matches, `${loaded}|${JSON.stringify(filter)}|${query}|${prefs.layout}|${prefs.group}|${prefs.sort}|${cols}`)
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
  const pickFilter = (next: NotesFilter, byKey = false) => {
    setNotes({ filter: next }); setActive(null)
    if (!byKey && !getNav().keyboardNav) { seen.current = new Set(); setEnterGen((n) => n + 1) }
  }
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
    return <Chip key={`${value}:${label}`} testId={`notes-filter-${value}`} label={label} selected={selected} dot={dot} onClick={(byKey) => pickFilter({ kind: value } as NotesFilter, byKey)} />
  }
  const filters = <div style={{ display: 'flex', alignItems: 'center', gap: 4, height: 28, marginTop: 20 }}>
    {chip('all', 'All')}
    {chip('global', 'Global')}
    {projects.filter((p) => choices.projects.some((c) => c.id === p.id)).map((p) => <Chip key={p.id} label={p.name} selected={filter.kind === 'project' && filter.projectId === p.id} dot={p.id} onClick={(byKey) => pickFilter({ kind: 'project', projectId: p.id }, byKey)} />)}
    {choices.threads > 0 && chip('threads', 'Threads')}
    <Menu testId="notes-projects" sideOffset={6} trigger={() => <IconButton icon={N.plus} label="Filter by another project" glyph={14} />}>
      {projects.map((p) => <MenuItem key={p.id} id={p.id} label={p.name} onSelect={() => pickFilter({ kind: 'project', projectId: p.id })} />)}
    </Menu>
    {filter.kind === 'deleted' && <Chip label="Recently deleted" selected onClick={(byKey) => pickFilter({ kind: 'deleted' }, byKey)} />}
    <div style={{ flexGrow: 1 }} />
    {choices.deleted > 0 && filter.kind !== 'deleted' && <Chip testId="notes-filter-deleted" label="Recently deleted" onClick={(byKey) => pickFilter({ kind: 'deleted' }, byKey)} />}
  </div>
  return <div testId="page-notes" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>
    {error && <div style={{ display: 'flex', gap: 10, padding: 24 }}><Label color={t.red}>{error}</Label><Button onClick={() => void refreshNotes()}>Try again</Button></div>}
    {!loaded ? <Empty title="Loading notes…" /> : <div ref={listFocus} tabIndex={0} onKeyDown={(e) => keys(e.key ?? '')} style={{ display: 'flex', flexGrow: 1, minHeight: 0 }}><virtual-list ref={list} testId="notes-gallery" style={{ flexGrow: 1, minHeight: 0 }}>
      {rows.map((row, index) => <div key={row.key} style={{ paddingLeft: gutter, paddingRight: gutter }}>
        {row.kind === 'filters' ? filters
          : row.kind === 'notice' ? <div style={{ paddingTop: 16, paddingBottom: 12 }}><Label color={k.fg3} size={NOTES_META} lineHeight={18}>{row.label!}</Label></div>
          : row.kind === 'header' ? <div style={{ paddingTop: row.first || row.list ? 24 : 4, paddingBottom: 10 }}><Label color={k.fg} size={NOTES_UI} lineHeight={18} weight={600}>{row.label!}</Label></div>
          : <div style={{ display: 'flex', gap: row.list ? 0 : 20, paddingBottom: row.list ? 0 : 24 }}>{row.notes!.map((note, column) => <NoteCard key={note.id} note={note} big={!!row.big} list={!!row.list} scope={note.scope === 'global' ? 'Global' : projectMap[note.project_id ?? '']?.name ?? 'Chats'} projectId={note.scope === 'global' ? null : note.project_id ?? null} active={active === note.id && keyboard} enter={!keyboard && ((enterGen > 0 && index < 5 && !seen.current.has(note.id)) || fresh.has(note.id))} enterGen={enterGen} leaving={leaving.get(note.id)} onGone={gone} index={index + column} onSeen={() => seen.current.add(note.id)} onFocus={() => setActive(note.id)} />)}{Array.from({ length: row.per! - row.notes!.length }, (_, i) => <div key={i} style={{ flexGrow: 1, flexBasis: 0 }} />)}</div>}
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

/** A scope chip: a `PickerChip` kept quiet and neutral (Notes keeps selection in ink), no chevron (a single-select filter). */
function Chip({ label, selected, dot, icon, onClick, testId }: { label: string; selected?: boolean; dot?: string | null; icon?: string; onClick: (byKey: boolean) => void; testId?: string }) {
  return <PickerChip quiet neutral chevron={false} testId={testId} label={label} selected={selected} icon={icon} lead={dot !== undefined && dot !== null ? <ProjectDot projectId={dot} /> : undefined}
    onKeyboard={() => onClick(true)} onClick={() => onClick(false)}>{label}</PickerChip>
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

const NoteCard = memo(function NoteCard({ note, big, list, scope, projectId, active, enter, enterGen, leaving, onGone, index, onSeen, onFocus }: { note: NoteSummary; big: boolean; list: boolean; scope: string; projectId: string | null; active: boolean; enter: boolean; /** Bumped by a pointer-picked filter: a card that stays mounted across it enters again with the cards that mount. */ enterGen: number; /** The generation of this card's exit (a pointer delete kept it mounted). */ leaving?: number; onGone: (id: string) => void; index: number; onSeen: () => void; onFocus: () => void }) {
  const t = useTheme()
  const k = notesTokens(t)
  // The entrance generation this card played (`-1`: none). A card mounts playing when it is fresh; one that stayed mounted replays
  // when a pointer-picked filter bumps `enterGen`, so the whole first screen rises together instead of only the cards that were new.
  const [played, setPlayed] = useState(enter ? enterGen : -1)
  if (enter && played !== enterGen) setPlayed(enterGen)
  const play = played !== -1
  // The lift answers pointer motion: a card that scrolls under a resting pointer does not lift (the wheel's own frames and a paint tween
  // each present, which costs vsyncs), the first mouse move over it does.
  const [hover, setHover] = useState(false)
  // `.note-card:active .note-thumb`: a primary press anywhere on the card settles the thumb to scale(0.985) (replacing the lift).
  const [pressed, setPressed] = useState(false)
  useEffect(() => { onSeen() }, [])
  const { done, total } = note.checklist
  const age = ageLabel(note.updated_at)
  // The card enters once (fresh gallery open or a pointer-picked filter) and leaves when a pointer delete keeps it mounted.
  const wrap = { paintTransform: leaving !== undefined ? cardLeave(leaving) : play ? withGeneration(cardIn(index), played) : undefined, onMotionComplete: leaving !== undefined ? (e: { motionGeneration?: number }) => { if (e.motionGeneration === leaving) onGone(note.id) } : undefined }
  if (list) {
    return <div {...wrap} style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0, position: 'relative', ...(leaving !== undefined ? { pointerEvents: 'none' } : {}) }}>
      <div testId={`note-card-${note.id}`} tabIndex={0} onFocus={onFocus} onClick={() => openNote(note.id)} onKeyDown={(e) => { if (e.key === 'enter') openNote(note.id) }} style={{ display: 'flex', alignItems: 'center', gap: 16, height: 40, marginLeft: -12, marginRight: -12, paddingLeft: 12, paddingRight: 12, borderRadius: 8, cursor: 'pointer', backgroundColor: active ? k.sel : undefined, hover: { backgroundColor: k.hover } }}>
        <div style={{ display: 'flex', minWidth: 80, maxWidth: '42%', flexShrink: 0 }}><Label color={k.fg} size={NOTES_UI} lineHeight={21} truncate>{noteTitle(note)}</Label></div>
        <div style={{ display: 'flex', flexGrow: 1, minWidth: 0 }}><Label color={k.fg3} size={NOTES_UI} lineHeight={21} truncate>{note.preview.trim()}</Label></div>
        {note.deleted_at ? null : <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: 148, flexShrink: 0 }}><ProjectDot projectId={projectId} /><Label color={k.fg2} size={NOTES_META} truncate>{scope}</Label></div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, width: 48, flexShrink: 0 }}>{total > 0 && <><Ring done={done} total={total} color={k.fg3} /><Label color={k.fg3} size={NOTES_META}>{`${done}/${total}`}</Label></>}</div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', width: 92, flexShrink: 0 }}><Label color={k.fg3} size={NOTES_META}>{age}</Label></div>
        </>}
      </div>
    </div>
  }
  return <div {...wrap} style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, flexBasis: 0, minWidth: 0, position: 'relative', ...(leaving !== undefined ? { pointerEvents: 'none' } : {}) }}>
    <div testId={`note-card-${note.id}`} tabIndex={0} onFocus={onFocus} onMouseMove={() => { if (!hover) setHover(true) }} onMouseLeave={() => { setHover(false); setPressed(false) }} onMouseDown={(e) => { if ((e.button ?? 0) === 0) setPressed(true) }} onMouseUp={() => setPressed(false)} onClick={() => openNote(note.id)} onKeyDown={(e) => { if (e.key === 'enter') openNote(note.id) }} style={{ display: 'flex', flexDirection: 'column', borderRadius: 12, cursor: 'pointer', marginLeft: 0 }}>
      <NoteThumb note={note} big={big} active={active} lift={hover && !pressed} pressed={pressed} />
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
  </div>
})

/** A paint motion that restarts from its `initial` whenever `generation` changes (undefined stays undefined). */
const withGeneration = <T extends object>(motion: T | undefined, generation: number) => (motion ? { ...motion, generation } : undefined)

export function Empty({ title, detail }: { title: string; detail?: string }) { const t = useTheme(); return <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flexGrow: 1, gap: 10 }}><Icon source={N.note} size={28} color={t.iconTertiary} /><Label color={t.text} size={17}>{title}</Label>{detail && <Label color={t.textSecondary}>{detail}</Label>}</div> }
