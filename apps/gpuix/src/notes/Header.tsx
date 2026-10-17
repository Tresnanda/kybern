import type { PublicInstance } from '@gpuix/react'
// The Notes title-bar content (desktop `SurfaceHeader` + `NotesGalleryChrome`):
// the title on the left; search, Display and New note on the right.
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { Menu, MenuItem, Tip } from '../nav/overlay.tsx'
import { globalNotesHome, setGlobalNotesHome } from './home.ts'
import { Label, useTheme } from '../ui.tsx'
import { CUSTOMIZE, NOTES_UI, notesTokens } from './kit.tsx'
import { display, newNote, refreshNotes, setNotes, useNotes } from './store.ts'

export function NotesHeaderTitle() {
  const t = useTheme()
  return <div style={{ paddingLeft: 2, paddingRight: 2 }}><Label color={t.text} size={NOTES_UI} lineHeight={21} weight={500}>Notes</Label></div>
}

export const notesSearchRef: { current: PublicInstance | null } = { current: null }

function Search() {
  const t = useTheme()
  const k = notesTokens(t)
  const query = useNotes((s) => s.query)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, width: 220, height: 28, marginRight: 4, paddingLeft: 9, paddingRight: 6, borderRadius: 8, backgroundColor: k.fill }}>
      <Icon source={N.search} size={14} color={k.fg3} />
      <input ref={(el) => { notesSearchRef.current = el }} testId="notes-search" aria-label="Search notes" placeholder="Search notes" value={query} onChange={(e) => setNotes({ query: e.value ?? '' })} style={{ flexGrow: 1, minWidth: 0, height: 28, fontSize: NOTES_UI, color: k.fg, backgroundColor: 'transparent', borderWidth: 0 }} />
    </div>
  )
}

function HeaderButton({ children, onClick, testId, width, start }: { children: React.ReactNode; onClick?: () => void; testId?: string; width?: number; start?: boolean }) {
  const t = useTheme()
  return <div testId={testId} onClick={onClick} style={{ display: 'flex', alignItems: 'center', justifyContent: start ? 'flex-start' : 'center', gap: 6, height: 28, minWidth: 28, width, paddingLeft: start ? 8 : width ? 0 : 8, paddingRight: width && !start ? 0 : 8, borderRadius: 10, cursor: 'pointer', hover: { backgroundColor: t.buttonTertiaryHover } }}>{children}</div>
}

export function NotesHeaderActions() {
  const t = useTheme()
  const k = notesTokens(t)
  const prefs = useNotes((s) => s.display)
  return (
    <>
      <Search />
      <Menu testId="notes-display" align="end" sideOffset={6} trigger={() => <HeaderButton width={82} start><Icon source={CUSTOMIZE} size={15} color={k.fg2} /><Label color={k.fg2} size={NOTES_UI}>Display</Label></HeaderButton>}>
        {(['gallery', 'list'] as const).map((value) => <MenuItem key={value} id={value} testId={`notes-layout-${value}`} label={value === 'gallery' ? 'Gallery' : 'List'} checked={prefs.layout === value} onSelect={() => display({ layout: value })} />)}
        {(['none', 'date', 'project'] as const).map((value) => <MenuItem key={value} id={value} label={`Group: ${value === 'none' ? 'None' : value === 'date' ? 'Date' : 'Project'}`} checked={prefs.group === value} onSelect={() => display({ group: value })} />)}
        {(['edited', 'created', 'title'] as const).map((value) => <MenuItem key={value} id={value} label={`Sort: ${value === 'edited' ? 'Last edited' : value === 'created' ? 'Created' : 'Title'}`} checked={prefs.sort === value} onSelect={() => display({ sort: value })} />)}
        <MenuItem id="global-home" testId="notes-global-home" label="Share Global notes across environments" checked={globalNotesHome() === 'shared'} onSelect={() => { setGlobalNotesHome(globalNotesHome() === 'shared' ? 'separate' : 'shared'); setNotes({ selected: null, loaded: false }); void refreshNotes() }} />
        <MenuItem id="hints" label="Show keyboard hints" checked={prefs.hints} onSelect={() => display({ hints: !prefs.hints })} />
      </Menu>
      <div style={{ display: 'flex', alignItems: 'center' }}><Tip label="New note" shortcut={['⌘', 'N']} side="bottom"><HeaderButton testId="notes-new" width={28} onClick={() => void newNote()}><Icon source={N.newThread} size={16} color={k.fg2} /></HeaderButton></Tip>
      <div style={{ marginLeft: -2 }}><HeaderButton width={28}><Icon source={N.chevronDown} size={12} color={k.fg2} /></HeaderButton></div></div>
    </>
  )
}
