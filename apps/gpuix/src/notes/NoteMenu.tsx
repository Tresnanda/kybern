import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { useGpuix } from '@gpuix/react'
import { useState } from 'react'
import { exportFileName, noteMarkdown } from '@/state/notesModel'
import type { NoteSummary } from '../../../../packages/kybern-client/src/types.ts'
import { Menu, MenuItem, Dialog } from '../nav/overlay.tsx'
import { Button } from '../settings/controls.tsx'
import { useApp } from '../state.ts'
import { toast } from '../shell/toasts.tsx'
import { Label, useTheme } from '../ui.tsx'
import { deleteNote, gallery, recordNote, refreshNotes, restoreNote, rpc } from './store.ts'

export async function copyMarkdown(title: string, body: string) {
  await new Promise<void>((resolve, reject) => { const child = spawn('pbcopy'); child.once('error', reject); child.once('close', (code) => code === 0 ? resolve() : reject(new Error('Clipboard unavailable'))); child.stdin.end(noteMarkdown(title, body)) })
}
export function NoteMenu({ note, readText }: { note: NoteSummary; readText?: () => { title: string; body: string } }) {
  const t = useTheme()
  const projects = useApp((s) => s.projects)
  const { renderer } = useGpuix()
  const [moving, setMoving] = useState(false)
  const [purging, setPurging] = useState(false)
  const run = (fn: () => Promise<unknown>) => { void fn().catch((e) => toast.error('Couldn’t update note', { description: String(e) })) }
  const text = async () => readText?.() ?? (await rpc().call('notes.get', { id: note.id })).note ?? { title: note.title, body: '' }
  const move = (projectId?: string) => run(async () => { recordNote(await rpc().call('notes.move', { id: note.id, scope: projectId ? 'project' : 'global', project_id: projectId })); setMoving(false) })
  return <>
    <Menu testId="note-menu" align="end" trigger={() => <div style={{ padding: 8 }}><Label color={t.textSecondary}>•••</Label></div>}>
      {!note.deleted_at && <MenuItem id="pin" testId="note-pin" label={note.pinned ? 'Unpin' : 'Pin'} onSelect={() => run(async () => recordNote(await rpc().call('notes.pin', { id: note.id, pinned: !note.pinned })))} />}
      {!note.deleted_at && note.scope !== 'thread' && !note.project_role && <MenuItem id="move" testId="note-move" label="Move to…" onSelect={() => setMoving(true)} />}
      <MenuItem id="copy" testId="note-copy" label="Copy as Markdown" onSelect={() => run(async () => { const current = await text(); await copyMarkdown(current.title, current.body); toast('Copied as Markdown') })} />
      <MenuItem id="export" label="Export…" onSelect={() => run(async () => {
        const folders = await renderer?.promptForPaths?.({ directories: true, files: false, prompt: 'Export here' })
        if (!folders?.[0]) return
        const current = await text()
        const filename = path.join(folders[0], exportFileName(current.title))
        // Exclusive creation never overwrites an existing export silently.
        await writeFile(filename, noteMarkdown(current.title, current.body), { flag: 'wx' })
        toast('Note exported', { description: filename })
      })} />
      {note.deleted_at ? <><MenuItem id="restore" label="Restore" onSelect={() => void restoreNote(note.id)} /><MenuItem id="purge" label="Delete forever…" destructive onSelect={() => setPurging(true)} /></> : <MenuItem id="delete" testId="note-delete" label="Delete" destructive onSelect={() => void deleteNote(note.id)} />}
    </Menu>
    {moving && <Dialog onClose={() => setMoving(false)} width={360}><div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 20 }}><Label color={t.text} size={17}>Move note</Label><Button onClick={() => move()}>Global</Button><virtual-list style={{ height: Math.min(280, projects.length * 36) }}>{projects.map((p) => <div key={p.id} style={{ paddingBottom: 8 }}><Button onClick={() => move(p.id)}>{p.name}</Button></div>)}</virtual-list></div></Dialog>}
    {purging && <Dialog onClose={() => setPurging(false)} width={400}><div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 20 }}><Label color={t.text} size={17}>Delete this note forever?</Label><Label color={t.textSecondary}>This cannot be undone.</Label><Button onClick={() => setPurging(false)}>Cancel</Button><Button testId="note-purge-confirm" onClick={() => run(async () => { await rpc().call('notes.purge', { id: note.id }); await refreshNotes(); gallery(); setPurging(false) })}>Delete forever</Button></div></Dialog>}
  </>
}
