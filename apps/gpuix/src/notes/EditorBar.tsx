// The open note's title-bar row (desktop `SurfaceHeader` in `NoteEditor.tsx`): back,
// the breadcrumb, then pin, share and more.
import { useSyncExternalStore } from 'react'
import { noteTitle } from '@/state/notesModel'
import { Icon, ICONS } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { Tip } from '../nav/overlay.tsx'
import { ink, Label, useTheme } from '../ui.tsx'
import { NoteMenu } from './NoteMenu.tsx'
import { notesTokens, NOTES_UI, SHARE } from './kit.tsx'
import { noteSession } from './session.ts'
import { gallery, recordNote, rpc, useNotes } from './store.ts'

function IconButton({ icon, label, shortcut, testId, onClick, pressed }: { icon: string; label: string; shortcut?: string[]; testId?: string; onClick?: () => void; pressed?: boolean }) {
  const t = useTheme()
  const k = notesTokens(t)
  return (
    <Tip label={label} shortcut={shortcut} side="bottom">
      <div testId={testId} aria-label={label} onClick={onClick} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 10, cursor: 'pointer', hover: { backgroundColor: t.buttonTertiaryHover } }}>
        <Icon source={icon} size={16} color={pressed ? k.fg : k.fg2} />
      </div>
    </Tip>
  )
}

export function NoteEditorBar({ id }: { id: string }) {
  const t = useTheme()
  const k = notesTokens(t)
  const note = useNotes((s) => s.notes.find((n) => n.id === id))
  const session = noteSession(id)
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot)
  if (!note) return null
  const title = snap.title.trim() || noteTitle(note)
  const readText = () => ({ title: snap.title, body: snap.body })
  return (
    <div style={{ display: 'flex', flexGrow: 1, alignItems: 'center', paddingLeft: 12 - 8, paddingRight: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <IconButton icon={N.arrowLeft} label="Back to Notes" shortcut={['Esc']} testId="notes-back" onClick={gallery} />
        <div testId="notes-crumb-root" onClick={gallery} style={{ display: 'flex', marginLeft: 2, paddingTop: 2, paddingBottom: 2, paddingLeft: 4, paddingRight: 4, borderRadius: 6, cursor: 'pointer' }}><Label color={k.fg3} size={NOTES_UI} lineHeight={21}>Notes</Label></div>
        <div style={{ marginLeft: 6, marginRight: 6 }}><Label color={k.fg4} size={NOTES_UI} lineHeight={21}>/</Label></div>
        <Label color={k.fg} size={NOTES_UI} lineHeight={21} weight={500} truncate>{title}</Label>
      </div>
      <div style={{ flexGrow: 1 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {!note.deleted_at && <IconButton icon={note.pinned ? N.pinFilled : N.pin} label={note.pinned ? 'Unpin' : 'Pin'} testId="note-pin" pressed={note.pinned} onClick={() => void rpc(id).call('notes.pin', { id, pinned: !note.pinned }).then(recordNote).catch(() => {})} />}
        <NoteMenu note={note} readText={readText} part="share" trigger={() => <IconButton icon={SHARE} label="Share" />} />
        <NoteMenu note={note} readText={readText} part="more" trigger={() => <IconButton icon={ICONS.ellipsis} label="More" />} />
      </div>
    </div>
  )
}
