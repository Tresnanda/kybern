import type { PublicInstance } from '@gpuix/react'
// The Notes title-bar content (desktop `SurfaceHeader` + `NotesGalleryChrome`):
// the title on the left; search, Display and New note on the right.
import { Button } from '../kit/Button.tsx'
import { SearchField } from '../kit/SearchField.tsx'
import { SplitButton } from '../kit/SplitButton.tsx'
import { Menu, MenuItem, MenuLabel, Tip } from '../nav/overlay.tsx'
import { useSpaceProjects } from '../spaces/current.ts'
import { globalNotesHome, setGlobalNotesHome } from './home.ts'
import { Label, useTheme } from '../ui.tsx'
import { CUSTOMIZE, NOTES_UI } from './kit.tsx'
import { createNote, display, newNote, openNote, refreshNotes, setNotes, useNotes } from './store.ts'

export function NotesHeaderTitle() {
  const t = useTheme()
  return <div style={{ paddingLeft: 2, paddingRight: 2 }}><Label color={t.text} size={NOTES_UI} lineHeight={21} weight={500}>Notes</Label></div>
}

export const notesSearchRef: { current: PublicInstance | null } = { current: null }

function Search() {
  const query = useNotes((s) => s.query)
  return <SearchField ref={(el) => { notesSearchRef.current = el }} testId="notes-search" label="Search notes" placeholder="Search notes" value={query} onChange={(value) => setNotes({ query: value })} width={220} shell={{ marginRight: 4 }} />
}

/** "New note in": the project or Global the note starts in (desktop `NewNoteMenu`). */
async function newNoteIn(projectId: string) { const note = await createNote('', '', projectId); if (note) openNote(note.id) }

export function NotesHeaderActions() {
  const projects = useSpaceProjects()
  const prefs = useNotes((s) => s.display)
  return (
    <>
      <Search />
      <Menu testId="notes-display" align="end" sideOffset={6} trigger={() => <Button icon={CUSTOMIZE} chevron>Display</Button>}>
        {(['gallery', 'list'] as const).map((value) => <MenuItem key={value} id={value} testId={`notes-layout-${value}`} label={value === 'gallery' ? 'Gallery' : 'List'} checked={prefs.layout === value} onSelect={() => display({ layout: value })} />)}
        {(['none', 'date', 'project'] as const).map((value) => <MenuItem key={value} id={value} label={`Group: ${value === 'none' ? 'None' : value === 'date' ? 'Date' : 'Project'}`} checked={prefs.group === value} onSelect={() => display({ group: value })} />)}
        {(['edited', 'created', 'title'] as const).map((value) => <MenuItem key={value} id={value} label={`Sort: ${value === 'edited' ? 'Last edited' : value === 'created' ? 'Created' : 'Title'}`} checked={prefs.sort === value} onSelect={() => display({ sort: value })} />)}
        <MenuItem id="global-home" testId="notes-global-home" label="Share Global notes across environments" checked={globalNotesHome() === 'shared'} onSelect={() => { setGlobalNotesHome(globalNotesHome() === 'shared' ? 'separate' : 'shared'); setNotes({ selected: null, loaded: false }); void refreshNotes() }} />
        <MenuItem id="hints" label="Show keyboard hints" checked={prefs.hints} onSelect={() => display({ hints: !prefs.hints })} />
      </Menu>
      <Tip label="New note" shortcut={['⌘', 'N']} side="bottom"><div><SplitButton variant="secondary" testId="notes-new" menuTestId="notes-new-more" menuLabel="New note in a project" onClick={() => void newNote()} menu={<><MenuLabel>New note in</MenuLabel><MenuItem id="global" label="Global" onSelect={() => void newNoteIn('')} />{projects.map((p) => <MenuItem key={p.id} id={p.id} label={p.name} onSelect={() => void newNoteIn(p.id)} />)}</>}>New note</SplitButton></div></Tip>
    </>
  )
}
