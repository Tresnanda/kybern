import { Segments } from '../usage/controls.tsx'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { setNav } from '../nav/store.ts'
import { chooseTab, setDock } from '../dock/store.ts'
import { AppNote } from './ComputerNotes.tsx'
import { useEffect, useState } from 'react'
import { notifications, type NotificationStatus } from '../native/notifications.ts'
import type { BackgroundSettings, ProviderKind } from '../../../../packages/kybern-client/src/types.ts'
import { getClient, useApp } from '../state.ts'
import { useNav } from '../nav/store.ts'
import { Label, useTheme } from '../ui.tsx'
import { Button, NumberField, PageBlock, Row, Section, Select, Switch, TextField } from './controls.tsx'
import { latestSettings, updateSettings, useSettings } from './store.ts'
import { useResource } from './resource.ts'

function Pages({ page, count, onChange }: { page: number; count: number; onChange: (page: number) => void }) {
  return count > 8 ? <Row title={`Page ${page + 1} of ${Math.ceil(count / 8)}`}><Button disabled={page === 0} onClick={() => onChange(page - 1)}>Previous</Button><Button disabled={(page + 1) * 8 >= count} onClick={() => onChange(page + 1)}>Next</Button></Row> : null
}

const FIELDS: { key: keyof Omit<BackgroundSettings, 'save_power_on_battery'>; title: string; description: string; unit: string; step: number }[] = [
  { key: 'session_idle_minutes', title: 'Release idle agents after', description: "Closes a quiet thread's agent. The next message starts it again.", unit: 'min', step: 5 },
  { key: 'max_idle_sessions', title: 'Keep idle agents warm', description: 'Past this many, the least recently used one is released first.', unit: 'agents', step: 1 },
  { key: 'terminal_idle_minutes', title: 'Close unattended shells after', description: 'Only shells with no tab open and nothing running.', unit: 'min', step: 5 },
  { key: 'daemon_idle_exit_minutes', title: 'Exit the daemon after', description: 'Once nothing needs it. Keep this off if you use the CLI or remote access.', unit: 'min', step: 5 },
]

export function Background() {
  const t = useTheme()
  const { settings, saving } = useSettings()
  const activity = useResource('daemon.activity', {})
  if (!settings) return null
  const update = (patch: Partial<BackgroundSettings>) => void updateSettings({ background: { ...latestSettings()!.background, ...patch } })
  return <Section title="Background"><div style={{ display: 'flex', flexDirection:'column', paddingLeft:12, paddingRight:12, paddingTop:16, paddingBottom:16, gap: 12 }}><Label color={t.text} size={14} lineHeight={21} weight={500}>Right now</Label><div style={{display:'flex'}}>{[
    ['Agents running', activity.data?.live_sessions], ['Idle, kept warm', activity.data?.idle_sessions], ['Shells open', activity.data?.terminals], ['Clients connected', activity.data?.connections],
  ].map(([label, count], index) => <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 4, flexGrow: 1, flexBasis:0, paddingLeft:index?16:0,borderLeftWidth:index?1:0,borderColor:t.border }}><Label color={t.text} size={20} lineHeight={24} weight={600}>{count === undefined ? '…' : String(count)}</Label><Label color={t.textSecondary} size={13} lineHeight={19.5}>{label}</Label></div>)}</div><Label color={t.textSecondary} size={14} lineHeight={21.7}>{activity.error || 'Running and approval-bound threads are never released.'}</Label></div>{FIELDS.map((field) => <Row key={field.key} title={field.title} description={field.description}><NumberField label={field.title} value={settings.background[field.key]} unit={field.unit} step={field.step} disabled={saving} onCommit={(value) => update({ [field.key]: value })} /></Row>)}<Row title="Save power on battery" description="Releases idle agents after a minute and holds harness updates until you plug in."><Switch label="Save power on battery" checked={settings.background.save_power_on_battery} disabled={saving} onChange={(save_power_on_battery) => update({ save_power_on_battery })} /></Row></Section>
}

export { Accounts } from './Accounts.tsx'

export function Integrations() {
  const t = useTheme()
  const [kind,setKind] = useState<'plugin'|'connector'>('plugin')
  const [query,setQuery] = useState('')
  const projects = useApp((s) => s.projects)
  const providers = useNav((s) => s.providers)
  const threads = useApp(s => s.threads)
  const selectedId = useApp(s => s.selectedId)
  const [project, setProject] = useState(projects[0]?.id ?? '')
  const [provider, setProvider] = useState<ProviderKind>('claude-code')
  const catalog = useResource('integrations.list', { project_id: project, provider }, !!project)
  const [page, setPage] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const items = (catalog.data?.items ?? []).filter(item => item.kind === kind && `${item.name} ${item.description??''}`.toLowerCase().includes(query.toLowerCase()))
  return <PageBlock><div style={{display:'flex',flexDirection:'column',gap:20}}>
   <div style={{display:'flex',alignItems:'center',gap:8}}><Select compact label="Agent" value={provider} onChange={value=>{setProvider(value as ProviderKind);setPage(0)}} options={[{value:'claude-code',label:'Claude Code'},...providers.filter(p=>p.kind!=='claude-code').map(p=>({value:p.kind,label:p.display_name,disabled:!p.available}))]}/><Select compact label="Project" value={project} onChange={value=>{setProject(value);setPage(0)}} options={projects.map(p=>({value:p.id,label:p.name}))}/><Button onClick={catalog.refresh}>Refresh</Button></div>
   <div style={{display:'flex',alignItems:'center',gap:12}}><Segments testId="integrations-kind" value={kind} options={[["plugin","Plugins"],["connector","Connectors"]]} onChange={value=>{setKind(value);setPage(0)}} width={72}/><div style={{flexGrow:1,position:'relative'}}><TextField testId="integrations-search" label="Find integration" placeholder={`Find a ${kind}`} value={query} onChange={setQuery} width="100%" style={{backgroundColor:'transparent',fontSize:14,paddingLeft:30}}/><div style={{position:'absolute',left:10,top:8,pointerEvents:'none'}}><Icon source={N.search} size={14} color={t.textSecondary}/></div></div></div>
   <Label color={t.textSecondary} size={12} lineHeight={18}>{kind==='plugin'?'Type / in a conversation to choose a plugin skill, such as /plugin:skill.':'Connectors give your agent access to tools and services.'}</Label>
   {!!(error||catalog.error||catalog.data?.warnings.length)&&<Label color={t.red}>{error||catalog.error||catalog.data?.warnings.join('\n')}</Label>}
{items.slice(page * 8, page * 8 + 8).map((item) => <Row key={`${item.kind}:${item.id}:${item.scope}`} title={item.name} description={[item.description, item.status].filter(Boolean).join('\n')}><Select label={`${item.name} action`} value="status" disabled={!!busy} options={[{ value: 'status', label: item.enabled ? 'Enabled' : item.installed ? 'Installed' : 'Not installed', disabled: true }, ...item.actions.map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }))]} onChange={async (action) => { setBusy(item.id); setError(''); try { await getClient()!.call('integrations.change', { project_id: project, provider, id: item.id, kind: item.kind, scope: item.scope, action: action as typeof item.actions[number] }); catalog.refresh() } catch (e) { setError(`Unable to change integration. ${String(e)}`) } finally { setBusy('') } }} />{item.can_login && <Button testId={`integration-login-${item.id}`} disabled={!!busy} onClick={async () => { const thread = threads.find(th => th.id === selectedId && th.project_id === project && th.provider.kind === provider && !th.subagent && th.status !== 'archived'); if (!thread) { setError('Open a conversation with this project and agent, then return here to sign in.'); return } setBusy(item.id); setError(''); try { const owner = getClient()!; await owner.call('integrations.login', { thread_id: thread.id, name: item.id }); if (getClient() !== owner) return; chooseTab(thread.id, 'terminal'); setDock(thread.id, { open: true }); setNav({ settingsOpen: false }) } catch(e) { setError(`Unable to sign in. ${String(e)}`) } finally { setBusy('') } }}>Sign in</Button>}</Row>)}{catalog.data && !items.length && <div style={{display:'flex',flexDirection:'column',gap:12,paddingTop:30,paddingBottom:30}}><div style={{width:36,height:36,borderRadius:18,display:'flex',alignItems:'center',justifyContent:'center',backgroundColor:t.buttonSecondary}}><Icon source={N.globe} size={18} color={t.textSecondary}/></div><Label color={t.text} size={14} weight={500}>{query?'No matches':`No ${kind==='plugin'?'plugins':'connectors'} yet`}</Label><Label color={t.textSecondary} size={14}>{query?'Try a different search.':kind==='plugin'?'Install a plugin skill in your agent, then refresh to see it here.':'Connect a service in your agent, then refresh to see it here.'}</Label></div>}<Pages page={page} count={items.length} onChange={setPage} /></div></PageBlock>
}

export function Computer() {
  const { settings, saving } = useSettings()
  const status = useResource('computer.status', {})
  const notes = useResource('computer.notes.list', {})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const setup = async (action: 'install' | 'grant_permissions') => { setBusy(true); setError(''); try { await getClient()!.call('computer.setup', { action }); status.refresh() } catch(e) { setError(`Unable to complete setup. ${String(e)}`) } finally { setBusy(false) } }
  const [page, setPage] = useState(0)
  if (!settings) return null
  const computer = settings.computer_use
  const update = (patch: Partial<typeof computer>) => void updateSettings({ computer_use: { ...latestSettings()!.computer_use, ...patch } })
  return <><Section title="Access"><Row title="Let agents use apps on this Mac" description="Agents can read an app’s window and click and type in it. You approve each app the first time a conversation uses it."><Switch label="Let agents use apps on this Mac" checked={computer.enabled} disabled={saving} onChange={(enabled) => update({ enabled })} /></Row><Row title="Your cursor and keyboard" description="Agents work in the background and leave your cursor alone. When a step needs the real cursor, or you ask to watch, they can ask to take over for that app."><Select label="Your cursor and keyboard" value={computer.foreground} disabled={saving} options={[{ value: 'ask', label: 'Ask first' }, { value: 'never', label: 'Never' }]} onChange={(v) => update({ foreground: v as 'ask' | 'never' })} /></Row><Row title="Show the agent’s cursor" description="Draws a second cursor on screen where agents click. CuaDriver can use over a gigabyte of memory while it’s on. The preview in each chat shows every step either way."><Switch label="Show the agent’s cursor" checked={computer.show_cursor ?? false} disabled={saving} onChange={(show_cursor) => update({ show_cursor })} /></Row><Row title="When agents ask first" description="This follows each chat’s permission mode. Full access never asks. Approve for me asks only before using your cursor. Other modes ask once per app, unless you allow it below." /><Row title="Apps allowed without asking" description={(computer.always_allowed_apps ?? []).length ? `${computer.always_allowed_apps!.length} apps. Remove access to ask again next time.` : 'None yet. Choose “Always allow” when an agent asks to use an app.'} />{computer.always_allowed_apps?.map(bundle => <Row key={bundle} title={bundle}><Button disabled={saving} onClick={() => update({ always_allowed_apps: computer.always_allowed_apps!.filter(app => app !== bundle) })}>Remove access</Button></Row>)}<Row title="" description="Codex uses its own computer use. Password managers, Keychain Access, and System Settings are never available to agents. Changes apply to new conversations." /></Section><Section title="Setup"><Row title="CuaDriver" description={error || status.error || (status.data && !status.data.supported ? 'Computer use requires macOS on the connected machine.' : status.data ? `${status.data.installed ? `Version ${status.data.version ?? 'unknown'}` : 'Not installed'} · ${status.data.ready ? 'Ready' : 'Finish setup below.'}` : 'Checking…')}><Button disabled={busy} onClick={status.refresh}>Check again</Button>{status.data?.supported && <Button testId="computer-setup" disabled={busy} onClick={() => void setup(status.data!.installed && status.data!.signed && !status.data!.checks.some(c => c.name === 'version' && !c.ok) ? 'grant_permissions' : 'install')}>{status.data.installed ? 'Finish setup' : 'Install CuaDriver'}</Button>}</Row><Row title="Accessibility" description={status.data?.accessibility ?? 'Checking…'} /><Row title="Screen Recording" description={status.data?.screen_recording ?? 'Checking…'} /></Section><Section title="App notes"><Row title="" description="When an app needs a non-obvious approach, agents note what worked. A later conversation sees an app’s notes the first time it uses that app. Edit an app’s notes below. Clearing a note removes it." />{notes.error && <Row title="Unable to read notes" description={notes.error} />}{notes.data?.notes.slice(page * 8, page * 8 + 8).map((note) => <AppNote key={`${note.bundle_id}:${note.text}`} note={note} refresh={notes.refresh} />)}{notes.data && !notes.data.notes.length && <Row title="No notes yet." />}<Pages page={page} count={notes.data?.notes.length ?? 0} onChange={setPage} /></Section></>
}
