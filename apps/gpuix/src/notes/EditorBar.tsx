// The open note's title-bar row (desktop `SurfaceHeader` in `NoteEditor.tsx`): back,
// the breadcrumb, then pin, share and more.
import { useSyncExternalStore } from 'react'
import { noteTitle } from '@/state/notesModel'
import { ICONS } from '../icons.tsx'
import { IconButton as KitIconButton } from '../kit/IconButton.tsx'
import { N } from '../nav/glyphs.ts'
import { Tip } from '../nav/overlay.tsx'
import { Label, useTheme } from '../ui.tsx'
import { NoteMenu } from './NoteMenu.tsx'
import { notesTokens, NOTES_UI, SHARE } from './kit.tsx'
import { noteSession } from './session.ts'
import { gallery, recordNote, rpc, useNotes } from './store.ts'

function IconButton({ icon, label, shortcut, testId, onClick, pressed }: { icon: string; label: string; shortcut?: string[]; testId?: string; onClick?: () => void; pressed?: boolean }) {
  return (
    <Tip label={label} shortcut={shortcut} side="bottom">
      <KitIconButton testId={testId} icon={icon} label={label} active={pressed} onClick={onClick} />
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
