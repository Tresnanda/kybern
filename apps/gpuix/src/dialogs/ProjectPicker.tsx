import { useEffect, useRef, useState } from 'react'
import type { ProjectsBrowseResult } from '../../../../packages/kybern-client/src/types.ts'
import { Dialog, DialogHeader } from '../nav/overlay.tsx'
import { Button, TextField } from '../settings/controls.tsx'
import { activeEnvironment } from '../shell/environment.ts'
import { getClient } from '../state.ts'
import { addProjectToCurrentSpace } from '../spaces/add.ts'
import { errorText } from '../nav/actions.ts'
import { Label, useTheme } from '../ui.tsx'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'

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
      // Into the active space; a folder that is a project elsewhere stays there, with a toast that offers to move it.
      await addProjectToCurrentSpace(path.trim())
      if (getClient() !== client) return
      close()
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  return <Dialog onClose={close} width={512} testId="project-picker"><DialogHeader title="Add project" description={`Choose a folder on ${activeEnvironment().name}.`} onClose={close} />
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingLeft:16, paddingRight:16, paddingTop:0, paddingBottom:12 }}>
      <Label color={t.text} size={14}>Folder path</Label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><TextField testId="project-picker-path" autoFocus label="Project folder path" value={path} onChange={setPath} onSubmit={() => void browse(path)} width="100%" style={{height:32,fontSize:14,backgroundColor:'transparent',borderColor:t.borderHeavy}} /><Button variant="secondary" testId="project-picker-open" disabled={busy || !path} onClick={() => void browse(path)}>Open folder</Button></div>
      <div style={{height:256,width:'100%',borderWidth:1,borderColor:t.border,borderRadius:8,padding:4}}><virtual-list testId="project-picker-folders" style={{height:246,width:'100%'}}>
        {listing?.parent && <div key="parent"><FolderRow testId="project-picker-parent" disabled={busy} onClick={() => void browse(listing.parent!)} name="Parent folder" /></div>}
        {listing?.directories.map((directory) => <div key={directory.path}><FolderRow disabled={busy} onClick={() => void browse(directory.path)} name={directory.name} /></div>)}
        {busy && <div key="loading" style={{ padding: 12 }}><Label color={t.textSecondary} size={12}>Loading folders…</Label></div>}
        {!busy && listing?.directories.length === 0 && <div key="empty" style={{ padding: 12 }}><Label color={t.textSecondary} size={12}>No subfolders. Add this folder as a project, or enter another path.</Label></div>}
        {listing?.has_more && <div key="more" style={{ padding: 12 }}><Label color={t.textSecondary} size={12}>Showing the first 1,000 folders. Enter a path to open another folder.</Label></div>}
      </virtual-list></div>
      {error && <Label color={t.red} size={12}>{error}</Label>}
      <div style={{ display: 'flex', justifyContent: 'flex-end',paddingTop:12 }}><Button variant="primary" testId="project-picker-add" disabled={busy || !path.trim()} onClick={() => void add()}>Add this folder</Button></div>
    </div>
  </Dialog>
}

function FolderRow({name,onClick,disabled,testId}:{name:string;onClick:()=>void;disabled:boolean;testId?:string}) {
 const t=useTheme()
 return <div testId={testId} tabIndex={disabled?-1:0} aria-label={name} onClick={()=>{if(!disabled)onClick()}} onKeyDown={e=>{if(!disabled&&(e.key==='enter'||e.key==='space'))onClick()}} style={{display:'flex',alignItems:'center',gap:8,minHeight:34,paddingLeft:8,paddingRight:8,borderRadius:6,hover:{backgroundColor:t.hover}}}><Icon source={N.folder} size={14} color={t.text}/><Label color={t.text} size={14} lineHeight={22}>{name}</Label></div>
}
