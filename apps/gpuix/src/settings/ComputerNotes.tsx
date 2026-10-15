import { useState } from 'react'
import type { ComputerNote } from '../../../../packages/kybern-client/src/types.ts'
import { getClient } from '../state.ts'
import { Label, useTheme } from '../ui.tsx'
import { Button, Row } from './controls.tsx'

export function AppNote({note,refresh}:{note:ComputerNote;refresh:()=>void}) {
 const t=useTheme();const [editing,setEditing]=useState(false),[text,setText]=useState(note.text),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const save=async()=>{setBusy(true);setError('');try{await getClient()!.call('computer.notes.set',{bundle_id:note.bundle_id,app:note.app,text});setEditing(false);refresh()}catch(e){setError(`Unable to save note. ${String(e)}`)}finally{setBusy(false)}}
 return <div><Row title={note.app} description={editing?note.bundle_id:note.text}><Button testId={`computer-note-${note.bundle_id}`} disabled={busy} onClick={()=>{setText(note.text);setEditing(!editing)}}>{editing?'Cancel':'Edit'}</Button></Row>{editing&&<div style={{display:'flex',flexDirection:'column',padding:18,gap:8}}><textarea testId="computer-note-text" aria-label="App notes" value={text} onChange={e=>setText(e.value??'')} style={{height:150,width:'100%',color:t.text,backgroundColor:t.surface,fontSize:13,padding:10}}/><Label color={t.textSecondary} size={12}>{`${Array.from(text).length}/1500 characters. Clear the note and save to remove it.`}</Label><Button testId="computer-note-save" disabled={busy||Array.from(text).length>1500} onClick={()=>void save()}>Save</Button>{error&&<Label color={t.red}>{error}</Label>}</div>}</div>
}
