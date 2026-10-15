import { useState } from 'react'
import type { AccountSummary, ProviderKind } from '../../../../packages/kybern-client/src/types.ts'
import { ACCOUNT_COLORS, ACCOUNT_COLOR_LABELS, isNameValid, isCliInstance } from '../../../desktop/src/lib/accounts.ts'
import { getClient, useApp } from '../state.ts'
import { showDialog } from '../dialogs/store.ts'
import { Dialog, DialogHeader } from '../nav/overlay.tsx'
import { Button, Row, Section, Select, TextField, useSettingsModal } from './controls.tsx'
import { latestSettings, updateSettings, useSettings } from './store.ts'
import { useResource } from './resource.ts'

export function Accounts() {
 const resource = useResource('providers.accounts.list', {})
 const { settings, saving } = useSettings()
 const projects = useApp(s => s.projects)
 const [project, setProject] = useState('')
 const [page, setPage] = useState(0)
 const [editing, setEditing] = useState<AccountSummary | null>(null)
 const [confirm, setConfirm] = useState<{account:AccountSummary; action:'sign_out'|'remove'} | null>(null)
 useSettingsModal(!!editing || !!confirm)
 const [name, setName] = useState('')
 const [color, setColor] = useState('blue')
 const [busy, setBusy] = useState(false)
 const [error, setError] = useState('')
 const accounts = resource.data?.accounts ?? []
 const run = async (action: () => Promise<unknown>) => {
  setBusy(true); setError('')
  try { await action(); resource.refresh(); setEditing(null); setConfirm(null) }
  catch(e) { setError(`Unable to change account. ${String(e)}`) }
  finally { setBusy(false) }
 }
 const configure = async (kind:ProviderKind, instance:string, projectPath?:string) => {
  const s=latestSettings(); if(!s) return
  const current=s.providers[kind] ?? {env:{}}
  const next={...current, project_accounts:{...current.project_accounts}}
  if(projectPath) { if(instance) next.project_accounts[projectPath]=instance; else delete next.project_accounts[projectPath] }
  else next.default_account=instance
  await updateSettings({providers:{...s.providers,[kind]:next}})
  resource.refresh()
 }
 return <>
  <Section title="Accounts">
   <Row title="Connected accounts" description={error || resource.error || 'Accounts share skills and plugins. Sign-ins and conversations stay separate.'}><Button testId="account-add" onClick={()=>showDialog({kind:'account'})}>Add account</Button><Button disabled={busy} onClick={resource.refresh}>Refresh</Button></Row>
   {resource.loading ? <Row title="Reading accounts…"/> : !accounts.length ? <Row title="No accounts found" description="Choose Add account to connect an agent."/> : accounts.slice(page*8,page*8+8).map(account=><Row key={`${account.provider.kind}:${account.provider.instance}`} title={`${account.name}${account.is_default?' · Default':''}`} description={`${account.provider.kind} · ${account.status.replaceAll('_', ' ')}${account.identity?.email?` · ${account.identity.email}`:''}`}>
    <Select testId={`account-actions-${account.provider.kind}-${account.provider.instance}`} label={`${account.name} actions`} value="actions" disabled={busy || saving} options={[{value:'actions',label:'Manage',disabled:true},{value:'default',label:'Make default',disabled:account.is_default},...(!isCliInstance(account.provider.instance)?[{value:'edit',label:'Edit name and color'},{value:'sign_out',label:'Sign out'},{value:'remove',label:'Remove account'}]:[])]} onChange={action=>{ if(action==='default') void configure(account.provider.kind,account.provider.instance); else if(action==='edit') {setName(account.name);setColor(account.color??'blue');setEditing(account)} else if(action==='sign_out'||action==='remove') setConfirm({account,action}) }}/>
   </Row>)}
   {accounts.length>8&&<Row title={`Page ${page+1}`}><Button disabled={!page} onClick={()=>setPage(page-1)}>Previous</Button><Button disabled={(page+1)*8>=accounts.length} onClick={()=>setPage(page+1)}>Next</Button></Row>}
  </Section>
  <Section title="Project overrides"><Row title="Project" description="New conversations use this account. Existing conversations keep theirs."><Select testId="account-project" label="Project" value={project} onChange={setProject} options={[{value:'',label:'Choose project'},...projects.map(p=>({value:p.path,label:p.name}))]}/></Row>
   {project&&[...new Set(accounts.map(a=>a.provider.kind))].map(kind=><Row key={kind} title={kind}><Select testId={`account-project-${kind}`} label={`${kind} account`} disabled={saving} value={settings?.providers[kind]?.project_accounts?.[project]??''} onChange={v=>void configure(kind,v,project)} options={[{value:'',label:'Use default account'},...accounts.filter(a=>a.provider.kind===kind).map(a=>({value:a.provider.instance,label:a.name}))]}/></Row>)}
  </Section>
  {editing&&<Dialog testId="account-edit" onClose={()=>{if(!busy)setEditing(null)}}><DialogHeader title="Edit account" onClose={()=>{if(!busy)setEditing(null)}}/><Row title="Name"><TextField testId="account-name" label="Account name" value={name} onChange={setName}/></Row><Row title="Color"><Select testId="account-color" label="Account color" value={color} onChange={setColor} options={ACCOUNT_COLORS.map(value=>({value,label:ACCOUNT_COLOR_LABELS[value]}))}/></Row><Row title={error}><Button testId="account-save" disabled={busy||!isNameValid(name)} onClick={()=>void run(()=>getClient()!.call('providers.accounts.update',{kind:editing.provider.kind,instance:editing.provider.instance,name:name.trim(),color}))}>Save</Button></Row></Dialog>}
  {confirm&&<Dialog testId="account-confirm" onClose={()=>{if(!busy)setConfirm(null)}}><DialogHeader title={confirm.action==='remove'?'Remove account?':'Sign out?'} description={`${confirm.account.name}. Existing conversations keep their account identity and may need you to sign in again.`} onClose={()=>{if(!busy)setConfirm(null)}}/><Row title={error}><Button disabled={busy} onClick={()=>setConfirm(null)}>Cancel</Button><Button testId="account-confirm-submit" disabled={busy} onClick={()=>void run(()=>getClient()!.call(confirm.action==='remove'?'providers.accounts.remove':'providers.accounts.sign_out',confirm.account.provider))}>{confirm.action==='remove'?'Remove account':'Sign out'}</Button></Row></Dialog>}
 </>
}
