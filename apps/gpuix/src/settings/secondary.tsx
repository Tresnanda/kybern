import { setNav } from '../nav/store.ts'
import { chooseTab, setDock } from '../dock/store.ts'
import { AppNote } from './ComputerNotes.tsx'
import { useState } from 'react'
import type { BackgroundSettings, ProviderKind } from '../../../../packages/kybern-client/src/types.ts'
import { getClient, useApp } from '../state.ts'
import { useNav } from '../nav/store.ts'
import { Label, useTheme } from '../ui.tsx'
import { Button, NumberField, Row, Section, Select, Switch } from './controls.tsx'
import { latestSettings, updateSettings, useSettings } from './store.ts'
import { useResource } from './resource.ts'

function Pages({ page, count, onChange }: { page: number; count: number; onChange: (page: number) => void }) {
  return count > 8 ? <Row title={`Page ${page + 1} of ${Math.ceil(count / 8)}`}><Button disabled={page === 0} onClick={() => onChange(page - 1)}>Previous</Button><Button disabled={(page + 1) * 8 >= count} onClick={() => onChange(page + 1)}>Next</Button></Row> : null
}

export function Notifications() {
  const { settings, saving } = useSettings()
  return <><Section title="Agent activity"><Row title="Show agent notifications" description="When work finishes, fails, or needs your input."><Switch label="Show agent notifications" testId="settings-notifications" checked={settings?.notifications ?? false} disabled={saving} onChange={(notifications) => void updateSettings({ notifications })} /></Row></Section><Section title="System notifications"><Row title="Notification access" description="System notification permission and test alerts are available in the desktop app. GPUIX does not yet deliver system alerts." /></Section></>
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
  return <Section title="Background"><Row title="Right now" description={activity.error || 'Running and approval-bound threads are never released.'}><Button onClick={activity.refresh}>Refresh</Button></Row><div style={{ display: 'flex', padding: 18, gap: 20 }}>{[
    ['Agents running', activity.data?.live_sessions], ['Idle, kept warm', activity.data?.idle_sessions], ['Shells open', activity.data?.terminals], ['Clients connected', activity.data?.connections],
  ].map(([label, count]) => <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 6, flexGrow: 1 }}><Label color={t.text} size={20} weight={600}>{count === undefined ? '…' : String(count)}</Label><Label color={t.textSecondary} size={11}>{label}</Label></div>)}</div>{FIELDS.map((field) => <Row key={field.key} title={field.title} description={field.description}><NumberField label={field.title} value={settings.background[field.key]} unit={field.unit} step={field.step} disabled={saving} onCommit={(value) => update({ [field.key]: value })} /></Row>)}<Row title="Save power on battery" description="Releases idle agents after a minute and holds harness updates until you plug in."><Switch label="Save power on battery" checked={settings.background.save_power_on_battery} disabled={saving} onChange={(save_power_on_battery) => update({ save_power_on_battery })} /></Row><Row title="" description="Set a limit to 0 to turn it off. Refresh Right now to read current activity." /></Section>
}

export { Accounts } from './Accounts.tsx'

export function Integrations() {
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
  return <><Section title="Project and agent"><Row title="Project"><Select label="Project" value={project} onChange={(value) => { setProject(value); setPage(0) }} options={projects.map((p) => ({ value: p.id, label: p.name }))} /></Row><Row title="Agent"><Select label="Agent" value={provider} onChange={(value) => { setProvider(value as ProviderKind); setPage(0) }} options={providers.map((p) => ({ value: p.kind, label: p.display_name, disabled: !p.available }))} /></Row></Section><Section title="Plugins and connectors"><Row title="Installed integrations" description={error || catalog.error || catalog.data?.warnings.join('\n') || (!project ? 'Add a project to manage its integrations.' : 'Changes apply to new agent sessions. Connector sign-in opens a terminal in a matching conversation.')}><Button onClick={catalog.refresh}>Refresh</Button></Row>{catalog.data?.items.slice(page * 8, page * 8 + 8).map((item) => <Row key={`${item.kind}:${item.id}:${item.scope}`} title={item.name} description={[item.description, item.status].filter(Boolean).join('\n')}><Select label={`${item.name} action`} value="status" disabled={!!busy} options={[{ value: 'status', label: item.enabled ? 'Enabled' : item.installed ? 'Installed' : 'Not installed', disabled: true }, ...item.actions.map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }))]} onChange={async (action) => { setBusy(item.id); setError(''); try { await getClient()!.call('integrations.change', { project_id: project, provider, id: item.id, kind: item.kind, scope: item.scope, action: action as typeof item.actions[number] }); catalog.refresh() } catch (e) { setError(`Unable to change integration. ${String(e)}`) } finally { setBusy('') } }} />{item.can_login && <Button testId={`integration-login-${item.id}`} disabled={!!busy} onClick={async () => { const thread = threads.find(th => th.id === selectedId && th.project_id === project && th.provider.kind === provider && !th.subagent && th.status !== 'archived'); if (!thread) { setError('Open a conversation with this project and agent, then return here to sign in.'); return } setBusy(item.id); setError(''); try { const owner = getClient()!; await owner.call('integrations.login', { thread_id: thread.id, name: item.id }); if (getClient() !== owner) return; chooseTab(thread.id, 'terminal'); setDock(thread.id, { open: true }); setNav({ settingsOpen: false }) } catch(e) { setError(`Unable to sign in. ${String(e)}`) } finally { setBusy('') } }}>Sign in</Button>}</Row>)}{catalog.data && !catalog.data.items.length && <Row title="No integrations found" />}<Pages page={page} count={catalog.data?.items.length ?? 0} onChange={setPage} /></Section></>
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
  return <><Section title="Access"><Row title="Let agents use apps on this Mac" description="Agents can read an app’s window and click and type in it. You approve each app the first time a conversation uses it."><Switch label="Let agents use apps on this Mac" checked={computer.enabled} disabled={saving} onChange={(enabled) => update({ enabled })} /></Row><Row title="Your cursor and keyboard" description="Agents work in the background and leave your cursor alone. When a step needs the real cursor, or you ask to watch, they can ask to take over for that app."><Select label="Your cursor and keyboard" value={computer.foreground} disabled={saving} options={[{ value: 'ask', label: 'Ask first' }, { value: 'never', label: 'Never' }]} onChange={(v) => update({ foreground: v as 'ask' | 'never' })} /></Row><Row title="Show the agent’s cursor" description="Draws a second cursor on screen where agents click. CuaDriver can use over a gigabyte of memory while it’s on. The preview in each chat shows every step either way."><Switch label="Show the agent’s cursor" checked={computer.show_cursor ?? false} disabled={saving} onChange={(show_cursor) => update({ show_cursor })} /></Row><Row title="When agents ask first" description="This follows each chat’s permission mode. Full access never asks. Approve for me asks only before using your cursor. Other modes ask once per app." /><Row title="Apps allowed without asking" description={(computer.always_allowed_apps ?? []).length ? `${computer.always_allowed_apps!.length} apps. Remove access to ask again next time.` : 'None yet. Choose “Always allow” when an agent asks to use an app.'} />{computer.always_allowed_apps?.map(bundle => <Row key={bundle} title={bundle}><Button disabled={saving} onClick={() => update({ always_allowed_apps: computer.always_allowed_apps!.filter(app => app !== bundle) })}>Remove access</Button></Row>)}<Row title="" description="Codex uses its own computer use. Password managers, Keychain Access, and System Settings are never available to agents. Changes apply to new conversations." /></Section><Section title="Setup"><Row title="CuaDriver" description={error || status.error || (status.data && !status.data.supported ? 'Computer use requires macOS on the connected machine.' : status.data ? `${status.data.installed ? `Version ${status.data.version ?? 'unknown'}` : 'Not installed'} · ${status.data.ready ? 'Ready' : 'Finish setup below.'}` : 'Checking…')}><Button disabled={busy} onClick={status.refresh}>Check again</Button>{status.data?.supported && <Button testId="computer-setup" disabled={busy} onClick={() => void setup(status.data!.installed && status.data!.signed && !status.data!.checks.some(c => c.name === 'version' && !c.ok) ? 'grant_permissions' : 'install')}>{status.data.installed ? 'Finish setup' : 'Install CuaDriver'}</Button>}</Row><Row title="Accessibility" description={status.data?.accessibility ?? 'Checking…'} /><Row title="Screen Recording" description={status.data?.screen_recording ?? 'Checking…'} /></Section><Section title="App notes"><Row title="" description="When an app needs a non-obvious approach, agents note what worked. A later conversation sees an app’s notes the first time it uses that app. Edit an app’s notes below. Clearing a note removes it." />{notes.error && <Row title="Unable to read notes" description={notes.error} />}{notes.data?.notes.slice(page * 8, page * 8 + 8).map((note) => <AppNote key={`${note.bundle_id}:${note.text}`} note={note} refresh={notes.refresh} />)}{notes.data && !notes.data.notes.length && <Row title="No notes yet." />}<Pages page={page} count={notes.data?.notes.length ?? 0} onChange={setPage} /></Section></>
}
