// Settings › Computer use: `views/SettingsScreen.tsx` `ComputerUseSettings` and `AppNotes`.
// Access (switch, cursor mode, agent cursor, allowed apps), Setup (CuaDriver,
// permissions) and per-app notes. Status is read on open and re-read every 4 s
// only while setup is unfinished, like the desktop; nothing polls once it is ready.
import { useEffect, useState } from 'react'
import type { ComputerNote, ComputerPermission, ComputerStatus } from '../../../../packages/kybern-client/src/types.ts'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { errorText } from '../nav/actions.ts'
import { toast } from '../shell/toasts.tsx'
import { getClient, useApp } from '../state.ts'
import { Label, ink, useTheme } from '../ui.tsx'
import { Row, Section, Select } from './controls.tsx'
import { Button } from '../kit/Button.tsx'
import { IconButton } from '../kit/IconButton.tsx'
import { TextArea } from '../kit/TextArea.tsx'
import { TokenChip } from '../kit/TokenChip.tsx'
import { Switch } from '../kit/Switch.tsx'
import { latestSettings, refreshSettings, updateSettings, useSettings } from './store.ts'

/** Mirrors the daemon's per-app limit (`computer/notes.rs`). */
const APP_NOTE_MAX_CHARS = 1500

export function ComputerUse() {
  const connected = useApp((s) => s.status === 'open')
  const { settings } = useSettings()
  const [status, setStatus] = useState<ComputerStatus | null>(null)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState<'install' | 'grant' | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const computer = settings?.computer_use
  const enabled = computer?.enabled ?? false
  // "Always allow" on an approval card changes settings in the daemon; read them fresh so the allowed apps are current.
  useEffect(() => { if (connected) void refreshSettings() }, [connected])
  const allowed = computer?.always_allowed_apps ?? []
  useEffect(() => {
    const client = getClient()
    if (!client || !connected) return
    let canceled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const next = await client.call('computer.status', {})
        if (canceled) return
        setStatus(next)
        setLoadError('')
        // Keep checking while the user works through setup in System Settings.
        if (next.enabled && next.installed && !next.ready) timer = setTimeout(() => void poll(), 4000)
      } catch (error) {
        if (!canceled) setLoadError(errorText(error))
      }
    }
    void poll()
    return () => { canceled = true; clearTimeout(timer) }
  }, [enabled, refreshKey, connected])
  const run = async (action: 'install' | 'grant_permissions') => {
    const client = getClient()
    if (!client) return
    setBusy(action === 'install' ? 'install' : 'grant')
    try {
      setStatus(await client.call('computer.setup', { action }))
      if (action === 'grant_permissions') toast('Follow CuaDriver’s prompts', { description: 'Allow Accessibility and Screen Recording for CuaDriver in System Settings. This page updates when they are on.' })
      setRefreshKey((key) => key + 1)
    } catch (error) {
      toast.error(action === 'install' ? 'Unable to install CuaDriver' : 'Unable to open permission setup', { description: errorText(error) })
    } finally {
      setBusy(null)
    }
  }
  if (!settings) return null
  if (loadError && !status) return <Section title="Computer use"><Row title="Unavailable on this machine" description={`${loadError}. Update Kybern on the connected machine to use computer use.`} /></Section>
  if (status && !status.supported) return <Section title="Computer use"><Row title="Needs a Mac" description="Computer use is available when Kybern runs on macOS." /></Section>
  const needsInstall = !!status && (!status.installed || status.checks.some((check) => (check.name === 'version' || check.name === 'signature') && !check.ok))
  const permissions = !!status && status.enabled && status.installed && !needsInstall
  const missingPermission = !!permissions && (status.accessibility !== 'granted' || status.screen_recording !== 'granted')
  const problems = status?.checks.filter((check) => !check.ok && !['installed', 'enabled', 'version', 'signature', 'accessibility', 'screen_recording'].includes(check.name)) ?? []
  const readiness = !enabled ? undefined : status?.ready ? 'Ready. Ask any agent except Codex to use an app, like “Add milk to my shopping list in Notes.”' : status ? 'Finish setup below to start.' : undefined
  const update = (patch: Partial<NonNullable<typeof computer>>) => void updateSettings({ computer_use: { enabled, foreground: 'ask', ...latestSettings()?.computer_use, ...patch } })
  const needsInstallMessage = status?.checks.find((check) => !check.ok && ['installed', 'version', 'signature'].includes(check.name))?.message
  return <>
    <Section title="Access">
      <Row title="Let agents use apps on this Mac" description="Agents can read an app’s window and click and type in it. You approve each app the first time a conversation uses it." status={readiness}><Switch testId="computer-enabled" aria-label="Let agents use apps on this Mac" checked={enabled} onCheckedChange={(checked) => update({ enabled: checked })} /></Row>
      <Row title="Your cursor and keyboard" description="Agents work in the background and leave your cursor alone. When a step needs the real cursor, or you ask to watch, they can ask to take over for that app."><Select testId="computer-foreground" label="Your cursor and keyboard" value={computer?.foreground ?? 'ask'} onChange={(foreground) => update({ foreground: foreground as 'ask' | 'never' })} options={[{ value: 'ask', label: 'Ask first' }, { value: 'never', label: 'Never' }]} /></Row>
      <Row title="Show the agent’s cursor" description="Draws a second cursor on screen where agents click. CuaDriver can use over a gigabyte of memory while it’s on. The preview in each chat shows every step either way."><Switch testId="computer-cursor" aria-label="Show the agent’s cursor" checked={computer?.show_cursor ?? false} onCheckedChange={(checked) => update({ show_cursor: checked })} /></Row>
      <Row title="When agents ask first" description="This follows each chat’s permission mode. Full access never asks. Approve for me asks only before using your cursor. Other modes ask once per app, unless you allow it below." />
      <Row title="Apps allowed without asking" description={allowed.length ? 'Agents use these in the background without asking. They still ask before taking over your cursor.' : 'None yet. Choose “Always allow” when an agent asks to use an app.'}>
        {allowed.length > 0 && <div testId="computer-allowed" style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 6, maxWidth: 320 }}>{allowed.map((app) => <AllowedApp key={app} app={app} onRemove={() => update({ always_allowed_apps: allowed.filter((item) => item !== app) })} />)}</div>}
      </Row>
      <Row title="" description="Codex uses its own computer use. Password managers, Keychain Access, and System Settings are never available to agents. Changes apply to new conversations." />
    </Section>
    <Section title="Setup">
      <Row title="CuaDriver" status={needsInstall ? needsInstallMessage : undefined} description={!status ? 'Checking…' : status.installed ? <CuaDriverVersion status={status} /> : 'The free, open-source app Kybern uses to see and control other apps. It installs into Applications.'}>
        {needsInstall ? <InstallButton busy={busy === 'install'} disabled={busy !== null} update={!!status?.installed} onClick={() => void run('install')} /> : status?.installed ? <PermissionState state="granted" granted="Installed" /> : null}
      </Row>
      {permissions && <Row title="Accessibility" description="Lets CuaDriver read app windows and click and type in them."><PermissionState state={status.accessibility} /></Row>}
      {permissions && <Row title="Screen Recording" description="Lets CuaDriver take screenshots of app windows."><PermissionState state={status.screen_recording} /></Row>}
      {missingPermission && <Row title="" description="CuaDriver asks macOS for both permissions. This page updates when they’re on."><Button testId="computer-grant" variant="primary" disabled={busy !== null} onClick={() => void run('grant_permissions')}>Grant access</Button></Row>}
      {!enabled && !!status?.installed && !needsInstall && <Row title="" description="Turn on computer use to check CuaDriver’s permissions." />}
      {problems.map((check) => <Row key={check.name} title="" description={check.message} status={check.fix ?? undefined} />)}
    </Section>
    <AppNotes />
  </>
}

function CuaDriverVersion({ status }: { status: ComputerStatus }) {
  const t = useTheme()
  return <div style={{ display: 'flex', flexDirection: 'column' }}><Label color={t.textSecondary} size={14} lineHeight={21.7}>{`Version ${status.version ?? 'unknown'}${status.signed ? ' · Signed by Cua AI' : ''}`}</Label>{status.app_path && <Label color={t.textSecondary} size={14} lineHeight={21.7} truncate>{status.app_path}</Label>}</div>
}

function InstallButton({ busy, disabled, update, onClick }: { busy: boolean; disabled: boolean; update: boolean; onClick: () => void }) {
  return <Button testId="computer-install" variant="primary" label={update ? 'Update CuaDriver' : 'Install CuaDriver'} busy={busy} disabled={disabled && !busy} onClick={onClick}>{busy ? 'Installing…' : update ? 'Update CuaDriver' : 'Install CuaDriver'}</Button>
}

/** `PermissionState`: a check and "Allowed"/"Installed", "Not allowed", or "Checking…". */
function PermissionState({ state, granted = 'Allowed' }: { state: ComputerPermission; granted?: string }) {
  const t = useTheme()
  const text = state === 'granted' ? granted : state === 'missing' ? 'Not allowed' : 'Checking…'
  return <div role="status" aria-label={text} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{state === 'granted' && <Icon source={N.check} size={14} color={t.v('--success')} />}<Label color={state === 'missing' ? t.text : t.textSecondary} size={12} lineHeight={16}>{text}</Label></div>
}

function AllowedApp({ app, onRemove }: { app: string; onRemove: () => void }) {
  return <TokenChip testId={`computer-allowed-chip-${app}`} removeTestId={`computer-allowed-${app}`} removeLabel={`Stop allowing ${app}`} onRemove={onRemove}>{app}</TokenChip>
}

function AppNotes() {
  const t = useTheme()
  const connected = useApp((s) => s.status === 'open')
  const [notes, setNotes] = useState<ComputerNote[] | null>(null)
  const [editing, setEditing] = useState<{ bundleId: string; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const client = getClient()
    if (!client || !connected) return
    let live = true
    client.call('computer.notes.list', {}).then((result) => live && setNotes(result.notes)).catch(() => live && setNotes([]))
    return () => { live = false }
  }, [connected])
  const save = async (note: ComputerNote, text: string) => {
    const client = getClient()
    if (!client) return
    setBusy(true)
    try {
      setNotes((await client.call('computer.notes.set', { bundle_id: note.bundle_id, text, app: note.app })).notes)
      setEditing(null)
      if (!text.trim()) toast(`Deleted the notes on ${note.app}`, { action: { label: 'Undo', onClick: () => void save(note, note.text) } })
    } catch (error) {
      toast.error(`Unable to save the notes on ${note.app}`, { description: errorText(error) })
    } finally {
      setBusy(false)
    }
  }
  if (notes === null) return null
  return <Section title="App notes">
    <Row title="" description="When an app needs a non-obvious approach, agents note what worked. A later conversation sees an app’s notes the first time it uses that app." />
    {notes.length === 0 && <Row title="" description="No notes yet." />}
    {notes.map((note) => editing?.bundleId === note.bundle_id
      ? <div key={note.bundle_id} style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingLeft: 18, paddingRight: 18, paddingTop: 16, paddingBottom: 16 }}>
        <Label color={t.text} size={14} lineHeight={21} weight={500}>{note.app}</Label>
        <TextArea testId="computer-note-text" label={`Notes on ${note.app}`} disabled={busy} value={editing.text} onChange={(text) => setEditing({ bundleId: note.bundle_id, text })} minRows={5} maxRows={12} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <Label color={editing.text.length > APP_NOTE_MAX_CHARS ? t.v('--destructive') : t.textSecondary} size={12} lineHeight={16}>{`${editing.text.length} of ${APP_NOTE_MAX_CHARS} characters`}</Label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(null)}>Cancel</Button>
            <Button testId="computer-note-save" size="sm" variant="secondary" disabled={busy || editing.text === note.text || editing.text.length > APP_NOTE_MAX_CHARS} onClick={() => void save(note, editing.text)}>Save notes</Button>
          </div>
        </div>
      </div>
      : <Row key={note.bundle_id} title={note.app} description={<Label color={t.textSecondary} size={14} lineHeight={21.7} style={{ maxWidth: 451 }}>{note.text.split('\n').slice(0, 4).join('\n')}</Label>}>
        <Button testId={`computer-note-edit-${note.bundle_id}`} disabled={busy} onClick={() => setEditing({ bundleId: note.bundle_id, text: note.text })}>Edit</Button>
        <IconButton testId={`computer-note-delete-${note.bundle_id}`} icon={N.x} label={`Delete the notes on ${note.app}`} size="sm" disabled={busy} onClick={() => void save(note, '')} />
      </Row>)}
  </Section>
}

