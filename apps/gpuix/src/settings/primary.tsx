import { activeEnvironment } from '../shell/environment.ts'
import { CursorSetup } from './Cursor.tsx'
import { load, save } from '../shell/persist.ts'
import { useState, useSyncExternalStore } from 'react'
import { globalNotesHome, setGlobalNotesHome, watchGlobalNotesHome } from '../notes/home.ts'
import { PERMISSION_HINT, PERMISSION_LABEL } from '../../../desktop/src/lib/format.ts'
import { AUTONOMY_OPTIONS, WORKSPACE_OPTIONS, COORDINATOR_ROLES, COORDINATOR_SETTINGS_COPY as COPY, autonomyHint, effectiveCoordinatorSettings, withGlobalRoleDefault } from '../../../../packages/kybern-client/src/coordinatorSettings.ts'
import type { PermissionMode, ProviderKind, OrchestrationSettings, RoleDefault } from '../../../../packages/kybern-client/src/types.ts'
import { getClient, useApp } from '../state.ts'
import { useNav } from '../nav/store.ts'
import { loadProviders } from '../nav/live.ts'
import { Label, ink, useTheme } from '../ui.tsx'
import { FONT_MONO } from '../theme.ts'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { Button, NumberField, PageBlock, Row, Section, Select, Switch, TextField } from './controls.tsx'
import { latestSettings, updateSettings, useSettings } from './store.ts'
import { setAppearance, useAppearance } from './appearance.ts'
import { useResource } from './resource.ts'

export function General() {
  const { settings: s, saving } = useSettings()
  const providers = useNav((s) => s.providers)
  const notesHome = useSyncExternalStore(watchGlobalNotesHome, globalNotesHome)
  const [ask, setAsk] = useState(() => load('kybern.askBeforeClose', true))
  if (!s) return null
  return <>
    <Section title="New threads">
      <Row title="Default agent" description="Used when you start a thread from a project."><Select label="Default agent" testId="settings-default-agent" value={s.default_provider} disabled={saving} onChange={(value) => void updateSettings({ default_provider: value as ProviderKind })} options={providers.map((p) => ({ value: p.kind, label: p.display_name, disabled: !p.available, mark: p.kind }))} /></Row>
      <Row title="Default permissions" description={PERMISSION_HINT[s.default_permission_mode]}><Select label="Default permissions" testId="settings-permissions" value={s.default_permission_mode} disabled={saving} onChange={(value) => void updateSettings({ default_permission_mode: value as PermissionMode })} options={Object.entries(PERMISSION_LABEL).map(([value, label]) => ({ value, label }))} /></Row>
      <Row title="Use a worktree for new threads" description="Each thread gets its own branch and folder. Projects can override this."><Switch label="Use a worktree for new threads" testId="settings-worktrees" checked={s.worktrees_default} disabled={saving} onChange={(worktrees_default) => void updateSettings({ worktrees_default })} /></Row>
    </Section>
    <Section title="Worktrees"><Row title="Remove eligible archived worktrees" description="Automatically remove clean, merged worktrees after archiving. Keeps branches and conversation history; continuing restores the folder."><Switch label="Remove eligible archived worktrees" testId="settings-cleanup" checked={s.automatic_worktree_cleanup ?? false} disabled={saving} onChange={(automatic_worktree_cleanup) => void updateSettings({ automatic_worktree_cleanup })} /></Row></Section>
    <Section title="Threads">
      <Row title="Generate thread titles" description="Names the thread from its first message using the agent."><Switch label="Generate thread titles" testId="settings-titles" checked={s.generate_titles} disabled={saving} onChange={(generate_titles) => void updateSettings({ generate_titles })} /></Row>
      <Row title="Tell agents about Kybern" description="Adds a short guide to new agent sessions: how to show images, link notes and tasks, and reach other threads."><Switch label="Tell agents about Kybern" checked={s.tell_agents_about_kybern ?? true} disabled={saving} onChange={(tell_agents_about_kybern) => void updateSettings({ tell_agents_about_kybern })} /></Row>
      <Row title="Ask before closing while threads work" description="Agents keep going after the window closes. The prompt lists them and offers to stop them."><Switch testId="settings-close-confirmation" label="Ask before closing while threads work" checked={ask} onChange={value => { save('kybern.askBeforeClose', value); setAsk(value) }} /></Row>
    </Section>
    <Section title="Notes"><Row title="Global notes" description="Notes that belong to no project. Shared keeps one set on this Mac for every environment window. Switching never moves or deletes a note."><Select label="Global notes" testId="settings-global-notes" value={notesHome} onChange={(value) => setGlobalNotesHome(value as 'shared' | 'separate')} options={[{ value: 'shared', label: 'Shared across environments' }, { value: 'separate', label: 'Separate per environment' }]} /></Row></Section>
    <PreviewFolders />
  </>
}

/** Folders outside a project that the user allowed Preview to serve files from (`PreviewFoldersRow`). */
function PreviewFolders() {
  const t = useTheme()
  const { settings, saving } = useSettings()
  const folders = settings?.preview_allowed_folders ?? []
  return <Section title="Preview"><Row title="Allowed folders" description={folders.length > 0 ? 'Pages in these folders can open in Preview. Files inside your projects never need this.' : 'None yet. Kybern asks the first time a page outside your projects opens in Preview.'}>{folders.length > 0 && <div testId="preview-folders" style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 320, maxWidth: '100%' }}>{folders.map((folder, index) => <div key={folder} testId={`preview-folder-${index}`} style={{ display: 'flex', alignItems: 'center', gap: 4, height: 28, paddingLeft: 10, paddingRight: 4, borderRadius: 6, backgroundColor: t.v('--color-background-elevated-secondary') }}><Label color={ink(t, 0.85)} size={11} lineHeight={16} font={FONT_MONO} truncate style={{ flexGrow: 1 }}>{startTruncate(folder)}</Label><Button testId={`preview-folder-remove-${index}`} size="xs" variant="ghost" label={`Remove ${folder}`} disabled={saving} onClick={() => void updateSettings({ preview_allowed_folders: folders.filter((p) => p !== folder) })}>Remove</Button></div>)}</div>}</Row></Section>
}

/** The desktop truncates the start of a path (`dir="rtl"`), so the folder's own name stays visible. */
const startTruncate = (path: string, max = 34) => path.length > max ? `…${path.slice(path.length - max + 1)}` : path

export function Agents() {
  const t = useTheme()
  const { settings: s, saving } = useSettings()
  const providers = useNav((s) => s.providers)
  const updates = useResource('harness_updates.list', {})
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState('')
  if (!s) return null
  const current = s.orchestration
  const effective = effectiveCoordinatorSettings(current, null)
  const change = (patch: Partial<OrchestrationSettings>) => void updateSettings({ orchestration: { ...latestSettings()!.orchestration, ...patch } })
  const runUpdate = async (kind: ProviderKind) => {
    setBusy(kind); setMessage('')
    try { const result = await getClient()!.call('harness_updates.run', { kind }); setMessage(result.message); updates.refresh(); await loadProviders(true) }
    catch (e) { setMessage(`Unable to start update. ${String(e)}`) }
    finally { setBusy('') }
  }
  return <>
    <Section title="Updates">
      <Row title="Update harnesses automatically" description="Check daily on this machine. Install when the agent's turns and background work are finished."><Switch label="Update harnesses automatically" testId="settings-harness-updates" checked={s.auto_update_harnesses} disabled={saving} onChange={(auto_update_harnesses) => void updateSettings({ auto_update_harnesses })} /></Row>
      <Row title="" description="Uses each CLI's updater or its existing Homebrew package. Custom binaries and version-managed installations stay under your control." />
      {!activeEnvironment().local && <Row title="Update the daemon automatically" description="Check the release feed daily on this machine. Install and restart when nothing is running."><Switch label="Update the daemon automatically" checked={s.auto_update_daemon} disabled={saving} onChange={(auto_update_daemon) => void updateSettings({ auto_update_daemon })} /></Row>}
      <DaemonUpdateRow />
    </Section>
    <OmpProfiles />
    <Section title="Delegation">
      <Row title="Active agents per thread" description="How many delegated agents one thread can have working at once. At the limit, the thread waits for one to finish before delegating again."><NumberField label="Active agents per thread" testId="settings-max-agents" unit="agents" min={1} max={16} value={current.max_active_children} disabled={saving} onCommit={(max_active_children) => change({ max_active_children })} /></Row>
      <Row title="Active agents per Coordinator" description="The same limit for a project's Coordinator, which usually runs more agents at once than an ordinary thread."><NumberField label="Active agents per Coordinator" unit="agents" min={1} max={16} value={current.lead_max_children} disabled={saving} onCommit={(lead_max_children) => change({ lead_max_children })} /></Row>
      <Row title="Delegation depth" description="1 lets only top-level threads delegate. 2 also lets their agents delegate again."><NumberField label="Delegation depth" unit="levels" min={1} max={4} value={current.max_depth} disabled={saving} onCommit={(max_depth) => change({ max_depth })} /></Row>
    </Section>
    <Section title={COPY.defaultsSection}>
      <Row title={COPY.autonomy} description={autonomyHint(effective.lead_autonomy)}><Select label={COPY.autonomy} value={effective.lead_autonomy} options={AUTONOMY_OPTIONS} disabled={saving} onChange={(v) => change({ lead_autonomy: v as OrchestrationSettings['lead_autonomy'] })} /></Row>
      <Row title={COPY.workspace} description="Where the Coordinator's agents edit when it doesn't choose. An own worktree keeps parallel work apart."><Select label={COPY.workspace} value={effective.lead_workspace} options={WORKSPACE_OPTIONS} disabled={saving} onChange={(v) => change({ lead_workspace: v as OrchestrationSettings['lead_workspace'] })} /></Row>
      <Row title={COPY.push} description={COPY.pushDetail}><Switch label={COPY.push} checked={effective.lead_push_without_asking} disabled={saving} onChange={(lead_push_without_asking) => change({ lead_push_without_asking })} /></Row>
      <Row title={COPY.models} description="When the Coordinator delegates without choosing a model. Each project can override these in its Project tab." />
      {COORDINATOR_ROLES.map(({ role, label }) => <RoleRow key={role} label={label} value={current.role_defaults?.[role]} onChange={(value) => void updateSettings({ orchestration: withGlobalRoleDefault(latestSettings()!.orchestration, role, value) })} />)}
    </Section>
    <Section title="Installed agents">{providers.map((p) => <Row key={p.kind} title={p.display_name} description={[p.unavailable_reason ?? p.binary_path ?? 'Not found on PATH', updates.data?.updates.find((u) => u.kind === p.kind)?.message].filter(Boolean).join('\n')}><Label color={t.textSecondary} size={12}>{p.version ?? (p.available ? 'Installed' : 'Not installed')}</Label>{p.available && p.kind !== 'cursor' && !s.providers[p.kind]?.binary && <Button disabled={!!busy} onClick={() => void runUpdate(p.kind)}>{busy === p.kind ? 'Updating…' : 'Update now'}</Button>}</Row>)}<Row title="Update status" description={message || updates.error || 'Refresh to read the latest update status.'}><Button onClick={updates.refresh}>Refresh</Button></Row></Section>
    <CursorSetup />
  </>
}

function DaemonUpdateRow() {
 const t = useTheme()
 const info = useResource('daemon.info', {})
 const update = useResource('daemon_update.status', {}, !activeEnvironment().local)
 const [busy, setBusy] = useState(false)
 const [error, setError] = useState('')
 const status = update.data
 const act = async () => {setBusy(true);setError('');try {await getClient()!.call(status?.status === 'available' ? 'daemon_update.run' : 'daemon_update.check', {});update.refresh()} catch(e) {setError(`Unable to update the daemon. ${String(e)}`)} finally {setBusy(false)}}
 return <Row title="kybernd" description={activeEnvironment().local ? 'Bundled with the app and updated with it.' : info.data ? `${info.data.hostname} · ${info.data.os} ${info.data.arch}` : '…'}><div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:8}}><div style={{display:'flex',alignItems:'center',gap:12}}><Label color={t.textSecondary} size={14}>{info.data?.version??'…'}</Label>{!activeEnvironment().local && <Button disabled={busy} onClick={()=>void act()}>{busy?'Checking…':status?.status==='available'&&status.latest_version?`Update to ${status.latest_version}`:'Check for updates'}</Button>}</div>{error&&<Label color={t.red} size={12}>{error}</Label>}</div></Row>
}

function RoleRow({ label, value, onChange }: { label: string; value?: RoleDefault; onChange: (value: RoleDefault | null) => void }) {
  const providers = useNav((s) => s.providers)
  const { saving } = useSettings()
  const chosen = providers.find((p) => p.kind === value?.provider?.kind)
  return <Row title={label}><div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><Select label={`${label} agent`} value={value?.provider?.kind ?? ''} disabled={saving} onChange={(kind) => onChange(kind ? { provider: { kind: kind as ProviderKind, instance: 'default' } } : null)} options={[{ value: '', label: COPY.sameAsCoordinator }, ...providers.filter((p) => p.available).map((p) => ({ value: p.kind, label: p.display_name }))]} />{chosen && <Select label={`${label} model`} value={value?.model ?? ''} disabled={saving} onChange={(model) => onChange({ ...value, model: model || null })} options={[{ value: '', label: 'Default model' }, ...(chosen.models ?? []).map((m) => ({ value: m.id, label: m.display_name || m.id }))]} />}{chosen?.supported_efforts?.length ? <Select label={`${label} effort`} value={value?.effort ?? ''} disabled={saving} onChange={(effort) => onChange({ ...value, effort: effort || null })} options={[{ value: '', label: 'Default effort' }, ...chosen.supported_efforts.map((value) => ({ value, label: value }))]} /> : null}</div></Row>
}

function ProfileField({ value, onSave, inherit }: { value?: string; onSave: (value: string) => void; inherit: string }) {
  const { saving } = useSettings()
  const [naming, setNaming] = useState(false)
  const [draft, setDraft] = useState(value ?? '')
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><Select label="OMP profile source" value={naming || (value && value !== 'default') ? 'named' : value === 'default' ? 'default' : 'inherit'} disabled={saving} options={[{ value: 'inherit', label: inherit }, { value: 'default', label: 'OMP default' }, { value: 'named', label: 'Named profile' }]} onChange={(mode) => { setNaming(mode === 'named'); if (mode !== 'named') onSave(mode === 'inherit' ? '' : 'default') }} />{(naming || (value && value !== 'default')) && <TextField label="Profile name" value={draft} onChange={setDraft} readOnly={saving} placeholder="Profile name" onBlur={() => { if (draft.trim() && draft.trim() !== value) onSave(draft.trim()) }} onSubmit={() => { if (draft.trim()) onSave(draft.trim()) }} />}</div>
}

function OmpProfiles() {
  const t = useTheme()
  const { settings: s } = useSettings()
  const projects = useApp((s) => s.projects)
  const [project, setProject] = useState(projects[0]?.path ?? '')
  const [expanded, setExpanded] = useState(false)
  if (!s) return null
  const omp = s.providers.omp ?? { env: {} }
  const save = (value: string, project?: string) => {
    const settings = latestSettings()!
    const current = settings.providers.omp ?? { env: {} }
    const next = { ...current, env: { ...current.env }, project_profiles: { ...current.project_profiles } }
    if (project) { if (value) next.project_profiles[project] = value; else delete next.project_profiles[project] }
    else { if (value) next.env.OMP_PROFILE = value; else delete next.env.OMP_PROFILE }
    void updateSettings({ providers: { ...settings.providers, omp: next } })
  }
  return <Section title="OMP profiles"><Row title="Default profile" description="For new chats."><ProfileField key={`default:${omp.env.OMP_PROFILE}`} value={omp.env.OMP_PROFILE} inherit="Use environment" onSave={(value) => save(value)} /></Row>{projects.length > 0 && <><div testId="omp-project-overrides" tabIndex={0} onClick={()=>setExpanded(!expanded)} onKeyDown={e=>{if(e.key==='enter'||e.key==='space')setExpanded(!expanded)}} style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:18}}><Label color={t.text} size={14}>Project overrides</Label><Icon source={expanded?N.arrowUp:N.chevronDown} size={14} color={t.textSecondary}/></div>{expanded&&<Row title="Project" description="Also applies to this project’s worktrees."><div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}><Select label="Choose project" value={project} onChange={setProject} options={projects.map((p) => ({ value: p.path, label: p.name }))} /><ProfileField key={`${project}:${omp.project_profiles?.[project]}`} value={omp.project_profiles?.[project]} inherit="Use default above" onSave={(value) => save(value, project)} /></div></Row>}</>}<Row title="" description="Existing chats keep their profile."/></Section>
}

export { About } from './About.tsx'
