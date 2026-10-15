import { useEffect, useRef, useState } from 'react'
import type { ProjectsBrowseResult } from '../../../../packages/kybern-client/src/types.ts'
import { Dialog, DialogHeader } from '../nav/overlay.tsx'
import { Button, TextField } from '../settings/controls.tsx'
import { activeEnvironment } from '../shell/environment.ts'
import { getClient, refreshLists, selectDraft } from '../state.ts'
import { errorText } from '../nav/actions.ts'
import { Label, useTheme } from '../ui.tsx'
import { setNav } from '../nav/store.ts'

export function ProjectPicker({ close }: { close: () => void }) {
  const t = useTheme()
  const [client] = useState(() => getClient()!)
  const [path, setPath] = useState('')
  const [listing, setListing] = useState<ProjectsBrowseResult | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)
  const sequence = useRef(0)
  const browse = async (path?: string) => {
    const attempt = ++sequence.current
    setBusy(true); setError('')
    try { const next = await client.call('projects.browse', path ? { path } : {}); if (attempt === sequence.current) { setPath(next.path); setListing(next) } }
    catch (e) { if (attempt === sequence.current) setError(errorText(e)) }
    finally { if (attempt === sequence.current) setBusy(false) }
  }
  useEffect(() => { void browse(); return () => { sequence.current++ } }, [client])
  const add = async () => {
    setBusy(true); setError('')
    try {
      const project = await client.call('projects.add', { path: path.trim() })
      if (getClient() !== client) return
      await refreshLists(); setNav({ page: 'home' }); selectDraft(project.id); close()
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  return <Dialog onClose={close} width={512} testId="project-picker"><DialogHeader title="Add project" description={`Choose a folder on ${activeEnvironment().name}.`} onClose={close} />
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16 }}>
      <Label color={t.text} size={12}>Folder path</Label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><TextField testId="project-picker-path" autoFocus label="Project folder path" value={path} onChange={setPath} onSubmit={() => void browse(path)} width="100%" /><Button testId="project-picker-open" disabled={busy || !path} onClick={() => void browse(path)}>Open folder</Button></div>
      <virtual-list testId="project-picker-folders" style={{ height: 256, width: '100%', borderWidth: 1, borderColor: t.border, borderRadius: 8 }}>
        {listing?.parent && <div key="parent" style={{ padding: 4 }}><Button testId="project-picker-parent" disabled={busy} onClick={() => void browse(listing.parent!)}>Parent folder</Button></div>}
        {listing?.directories.map((directory) => <div key={directory.path} style={{ padding: 4 }}><Button disabled={busy} onClick={() => void browse(directory.path)}>{directory.name}</Button></div>)}
        {busy && <div key="loading" style={{ padding: 12 }}><Label color={t.textSecondary} size={12}>Loading folders…</Label></div>}
        {!busy && listing?.directories.length === 0 && <div key="empty" style={{ padding: 12 }}><Label color={t.textSecondary} size={12}>No subfolders. Add this folder as a project, or enter another path.</Label></div>}
        {listing?.has_more && <div key="more" style={{ padding: 12 }}><Label color={t.textSecondary} size={12}>Showing the first 1,000 folders. Enter a path to open another folder.</Label></div>}
      </virtual-list>
      {error && <Label color={t.red} size={12}>{error}</Label>}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}><Button testId="project-picker-add" disabled={busy || !path.trim()} onClick={() => void add()}>Add this folder</Button></div>
    </div>
  </Dialog>
}
