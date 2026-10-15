import { Label, ProviderMark, useTheme } from '../ui.tsx'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { useNav } from '../nav/store.ts'
import { useState } from 'react'
import type { AccountSummary, ProviderKind } from '../../../../packages/kybern-client/src/types.ts'
import { ACCOUNT_COLORS, ACCOUNT_COLOR_LABELS, isNameValid, isCliInstance } from '../../../desktop/src/lib/accounts.ts'
import { getClient, useApp } from '../state.ts'
import { showDialog } from '../dialogs/store.ts'
import { Menu, MenuItem, Dialog, DialogHeader } from '../nav/overlay.tsx'
import { Button, PageBlock, Row, Section, Select, TextField, useSettingsModal, selectOwnsEscape } from './controls.tsx'
import { latestSettings, updateSettings, useSettings } from './store.ts'
import { useResource } from './resource.ts'

const accountRgb = { blue:['1,105,204','51,134,214'], green:['0,162,64','47,191,99'], purple:['117,30,217','176,109,255'], pink:['194,48,122','232,106,166'], teal:['15,143,134','51,191,179'], amber:['217,119,6','245,180,74'] }
function accountTint(color:string|null|undefined, dark:boolean, alpha:number) {
 const rgb=accountRgb[color as keyof typeof accountRgb]??accountRgb.blue
 return `rgba(${rgb[dark?1:0]},${alpha})`
}

export function AccountsHeaderAction() {
 const t = useTheme()
 return <div testId="account-add" tabIndex={0} aria-label="Add account" onClick={() => showDialog({kind:'account'})} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') showDialog({kind:'account'}) }} style={{ display:'flex', alignItems:'center', gap:6, height:28, paddingLeft:10, paddingRight:10, borderWidth:1, borderColor:t.border, borderRadius:8, flexShrink:0, hover:{backgroundColor:t.hover} }}><Icon source={N.plus} size={14} color={t.text}/><Label color={t.text} size={14}>Add account</Label></div>
}

export function Accounts() {
 const t = useTheme()
 const providers = useNav(s => s.providers)
 const [assigning, setAssigning] = useState(false)
 const resource = useResource('providers.accounts.list', {})
 const { settings, saving } = useSettings()
 const projects = useApp(s => s.projects)
 const [project, setProject] = useState('')
 const [page, setPage] = useState(0)
 const [editing, setEditing] = useState<AccountSummary | null>(null)
 const [confirm, setConfirm] = useState<{account:AccountSummary; action:'sign_out'|'remove'} | null>(null)
 useSettingsModal(!!editing || !!confirm || assigning)
 const [name, setName] = useState('')
 const [color, setColor] = useState('blue')
 const [busy, setBusy] = useState(false)
 const [error, setError] = useState('')
 const accounts = resource.data?.accounts ?? []
 const visibleAccounts = accounts.slice(page*8,page*8+8)
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
  {(error || resource.error) && <PageBlock><Label color={t.red} size={14}>{error || resource.error}</Label></PageBlock>}
  {resource.loading ? <PageBlock><Label color={t.textSecondary}>Reading accounts…</Label></PageBlock> : !accounts.length ? <Section title="Accounts"><Row title="No accounts found" description="Choose Add account to connect an agent." /></Section> : [...new Set(visibleAccounts.map(a => a.provider.kind))].map(kind => {
   const provider = providers.find(p => p.kind === kind)
   const label = provider?.display_name ?? kind
   return <PageBlock key={kind}><div style={{display:'flex',flexDirection:'column',gap:12,paddingBottom:30}}>
    <div style={{display:'flex',alignItems:'center',gap:6,paddingLeft:2}}><ProviderMark kind={kind} size={14}/><Label color={t.text} size={14} lineHeight={19.6} weight={600}>{label}</Label></div>
    <div style={{display:'flex',flexDirection:'column',borderWidth:1,borderColor:t.v('--app-settings-card-border'),borderRadius:12,backgroundColor:t.v('--app-settings-card-surface'),overflow:'hidden'}}>
     {visibleAccounts.filter(a => a.provider.kind === kind).map((account, index) => <div key={account.provider.instance} style={{display:'flex',alignItems:'center',gap:12,paddingLeft:18,paddingRight:18,paddingTop:12,paddingBottom:12,minHeight:56,borderTopWidth:index?1:0,borderColor:t.v('--app-settings-card-border')}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'center',width:32,height:32,flexShrink:0,borderRadius:8,backgroundColor:accountTint(account.color,t.variant==='dark',0.14),borderWidth:1,borderColor:accountTint(account.color,t.variant==='dark',0.35)}}><ProviderMark kind={kind} size={18}/></div>
      <div style={{display:'flex',flexDirection:'column',flexGrow:1,minWidth:0}}><div style={{display:'flex',alignItems:'center',gap:8}}><Label color={t.text} size={14} lineHeight={21} weight={500}>{account.name}</Label>{account.is_default&&<Label color={t.textSecondary} size={11}>Default</Label>}</div><Label color={t.textSecondary} size={14} lineHeight={21} truncate>{account.identity?.email ?? 'Email unavailable'}</Label></div>
      <Label color={t.textSecondary} size={12}>{account.status==='signed_in'?'Signed in':account.status==='signed_out'?'Signed out':'Needs sign-in'}</Label>
      <Menu testId={`account-actions-${kind}-${account.provider.instance}`} align="end" trigger={()=><div style={{display:'flex',alignItems:'center',justifyContent:'center',width:28,height:28,borderRadius:6,hover:{backgroundColor:t.hover}}}><Icon source={N.ellipsis} size={16} color={t.textSecondary}/></div>}>
       <MenuItem id="default" testId={`account-actions-${kind}-${account.provider.instance}-default`} label="Make default" disabled={account.is_default||busy||saving} onSelect={()=>void configure(kind,account.provider.instance)}/>
       <MenuItem id="projects" testId={`account-actions-${kind}-${account.provider.instance}-projects`} label="Assign projects" onSelect={()=>setAssigning(true)}/>
       {!isCliInstance(account.provider.instance)&&<><MenuItem id="edit" testId={`account-actions-${kind}-${account.provider.instance}-edit`} label="Edit name and color" onSelect={()=>{setName(account.name);setColor(account.color??'blue');setEditing(account)}}/><MenuItem id="sign_out" testId={`account-actions-${kind}-${account.provider.instance}-sign_out`} label="Sign out" onSelect={()=>setConfirm({account,action:'sign_out'})}/><MenuItem id="remove" testId={`account-actions-${kind}-${account.provider.instance}-remove`} label="Remove account" onSelect={()=>setConfirm({account,action:'remove'})}/></>}
      </Menu>
     </div>)}
     <div tabIndex={0} aria-label={`Add ${label} account`} onClick={()=>showDialog({kind:'account',provider:kind})} onKeyDown={e=>{if(e.key==='enter'||e.key==='space')showDialog({kind:'account',provider:kind})}} style={{display:'flex',alignItems:'center',gap:8,minHeight:44,paddingLeft:18,paddingRight:18,borderTopWidth:1,borderColor:t.v('--app-settings-card-border'),hover:{backgroundColor:t.hover}}}><Icon source={N.plus} size={16} color={t.textSecondary}/><Label color={t.textSecondary} size={14}>{`Add ${label} account`}</Label></div>
    </div>
    {accounts.length>8&&<Row title={`Page ${page+1}`}><Button disabled={!page} onClick={()=>setPage(page-1)}>Previous</Button><Button disabled={(page+1)*8>=accounts.length} onClick={()=>setPage(page+1)}>Next</Button></Row>}
   </div></PageBlock>
  })}
  {assigning&&<Dialog testId="account-projects" onClose={()=>{if(!selectOwnsEscape())setAssigning(false)}}><DialogHeader title="Assign projects" onClose={()=>{if(!selectOwnsEscape())setAssigning(false)}}/><Row title="Project" description="New conversations use this account. Existing conversations keep theirs."><Select testId="account-project" label="Project" value={project} onChange={setProject} options={[{value:'',label:'Choose project'},...projects.map(p=>({value:p.path,label:p.name}))]}/></Row>
   {project&&[...new Set(accounts.map(a=>a.provider.kind))].map(kind=><Row key={kind} title={kind}><Select testId={`account-project-${kind}`} label={`${kind} account`} disabled={saving} value={settings?.providers[kind]?.project_accounts?.[project]??''} onChange={v=>void configure(kind,v,project)} options={[{value:'',label:'Use default account'},...accounts.filter(a=>a.provider.kind===kind).map(a=>({value:a.provider.instance,label:a.name}))]}/></Row>)}
  </Dialog>}
  {editing&&<Dialog testId="account-edit" onClose={()=>{if(!busy&&!selectOwnsEscape())setEditing(null)}}><DialogHeader title="Edit account" onClose={()=>{if(!busy&&!selectOwnsEscape())setEditing(null)}}/><Row title="Name"><TextField testId="account-name" label="Account name" value={name} onChange={setName}/></Row><Row title="Color"><Select testId="account-color" label="Account color" value={color} onChange={setColor} options={ACCOUNT_COLORS.map(value=>({value,label:ACCOUNT_COLOR_LABELS[value]}))}/></Row><Row title={error}><Button testId="account-save" disabled={busy||!isNameValid(name)} onClick={()=>void run(()=>getClient()!.call('providers.accounts.update',{kind:editing.provider.kind,instance:editing.provider.instance,name:name.trim(),color}))}>Save</Button></Row></Dialog>}
  {confirm&&<Dialog testId="account-confirm" onClose={()=>{if(!busy)setConfirm(null)}}><DialogHeader title={confirm.action==='remove'?'Remove account?':'Sign out?'} description={`${confirm.account.name}. Existing conversations keep their account identity and may need you to sign in again.`} onClose={()=>{if(!busy)setConfirm(null)}}/><Row title={error}><Button disabled={busy} onClick={()=>setConfirm(null)}>Cancel</Button><Button testId="account-confirm-submit" disabled={busy} onClick={()=>void run(()=>getClient()!.call(confirm.action==='remove'?'providers.accounts.remove':'providers.accounts.sign_out',confirm.account.provider))}>{confirm.action==='remove'?'Remove account':'Sign out'}</Button></Row></Dialog>}
 </>
}
