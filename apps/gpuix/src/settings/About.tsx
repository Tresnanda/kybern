// Settings › About (desktop `SettingsScreen.tsx` `About`, `AppUpdateRow`,
// `CommandLineRow`): the app version with its update action, the update track,
// the connected daemon, and the bundled `kybern` command (`platform/cli.ts`).
import { useEffect, useState } from 'react'
import { Label, useTheme } from '../ui.tsx'
import { toast } from '../shell/toasts.tsx'
import { canCheckForUpdates, checkForAppUpdate, installAppUpdate, manualUpdateText, updateTrackChanged, useAppUpdate, type UpdateTrack } from '../platform/update.ts'
import { CopyUpdateCommand } from '../platform/UpdateSurface.tsx'
import { cliStatus, installCli, managedCliCopy, removeOtherCli, uninstallCli, type CliStatus } from '../platform/cli.ts'
import { Row, Section } from './controls.tsx'
import { Button } from '../kit/Button.tsx'
import { Segmented } from '../kit/Segmented.tsx'
import { useResource } from './resource.ts'
import { latestSettings, updateSettings, useSettings } from './store.ts'

type Line = { text: string; tone?: 'muted' | 'warning' | 'error' }

/** `Row` with a description of several lines (desktop rows use spans with roles). */
function DetailRow({ title, lines, children, testId }: { title: string; lines: Line[]; children?: React.ReactNode; testId?: string }) {
  const t = useTheme()
  return <div testId={testId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20, paddingLeft: 18, paddingRight: 18, paddingTop: 16, paddingBottom: 16 }}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexGrow: 1, minWidth: 0 }}>
      <Label color={t.text} size={14} lineHeight={21} weight={500}>{title}</Label>
      {lines.map((line, i) => <Label key={i} color={line.tone === 'error' ? t.red : line.tone === 'warning' ? t.text : t.textSecondary} size={14} lineHeight={21.7} style={{ maxWidth: 451 }}>{line.text}</Label>)}
    </div>
    {children && <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>{children}</div>}
  </div>
}

function AppUpdateRow() {
  const update = useAppUpdate(s => s)
  const busy = update.phase === 'checking' || update.phase === 'installing'
  const label = update.phase === 'checking' ? 'Checking…'
    : update.phase === 'installing' ? (update.progress === null ? 'Installing…' : `Installing… ${Math.round(update.progress * 100)}%`)
    : update.phase === 'available' ? (update.manual ? `Download ${update.version}` : `Update to ${update.version}`)
    : 'Check for updates'
  const status = update.phase === 'available' ? (update.manual ? `${update.version} is out. ${manualUpdateText(update.manual)}` : `${update.version} is ready. Installing restarts the app and the agents running on this machine.`)
    : update.phase === 'error' ? update.error
    : update.phase === 'current' && update.unpublished ? `Kybern ${update.unpublished} is out. This preview updates once its build is published.`
    : update.phase === 'current' && update.checkedAt ? `Up to date · checked ${new Date(update.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : null
  return <DetailRow title="Kybern" testId="about-app" lines={[{ text: update.appVersion ?? '…' }, ...(status ? [{ text: status, tone: update.phase === 'error' ? 'error' as const : 'muted' as const }] : [])]}>
    {update.phase === 'available' && update.manual?.command && <CopyUpdateCommand command={update.manual.command} testId="about-update-copy" />}
    {canCheckForUpdates() && <Button testId="about-update" disabled={busy} onClick={() => void (update.phase === 'available' ? installAppUpdate() : checkForAppUpdate({ manual: true }))}>{label}</Button>}
  </DetailRow>
}

const TRACK_OPTIONS = [{ value: 'stable', label: 'Stable' }, { value: 'dev', label: 'Dev' }] as const

/** A version with a prerelease part (`0.21.0-dev.2`) is a dev build. */
const isDevBuild = (version: string | null) => !!version && /^v?\d+\.\d+\.\d+-/.test(version)

/**
 * The daemon's `update_track` setting (shared across the machine network): this app and every daemon that updates
 * itself read it. Leaving Dev never downgrades; the status line says so.
 */
function UpdateTrackRow() {
  const { settings, saving } = useSettings()
  const appVersion = useAppUpdate(s => s.appVersion)
  if (!settings) return null
  const track: UpdateTrack = settings.update_track === 'dev' ? 'dev' : 'stable'
  const status = track === 'dev' ? 'Switching back to Stable keeps this version until a stable release is newer.'
    : isDevBuild(appVersion) ? `Kybern stays on ${appVersion} until a stable release is newer.`
    : undefined
  const choose = (value: string) => {
    const next = value === 'dev' ? 'dev' : 'stable'
    if (next === track) return
    // Look again only once the daemon saved it; a failed save shows its error and leaves the track as it was.
    void updateSettings({ update_track: next }).then(() => { if (latestSettings()?.update_track === next) updateTrackChanged(next) })
  }
  return <Row title="Update track" description="Dev gets new features first and may have rough edges. Stable gets them once they have settled." status={status} shared="update_track">
    <Segmented testId="about-update-track" aria-label="Update track" options={TRACK_OPTIONS} value={track} busy={saving} onChange={choose} />
  </Row>
}

export function About() {
  const info = useResource('daemon.info', {})
  return <>
    <Section title="About">
      <AppUpdateRow />
      <UpdateTrackRow />
      <Row title="Daemon" description={info.data?.version ?? '…'} />
      <Row title="Protocol" description={info.data ? String(info.data.protocol_version) : '…'} />
      <Row title="Host" description={info.data ? `${info.data.hostname} · ${info.data.os} ${info.data.arch}` : '…'} />
      <Row title="Data" description={info.data?.data_dir ?? '…'} />
    </Section>
    <Section title="Command line"><CommandLineRow /></Section>
  </>
}

/** The `kybern` command shipped inside the app: a link made here (macOS, a Linux AppImage), or the installer's or package's own (Windows, deb, rpm). */
function CommandLineRow() {
  const [status, setStatus] = useState<CliStatus | null>(null)
  const [busy, setBusy] = useState<'install' | 'uninstall' | 'remove' | null>(null)
  const [justInstalled, setJustInstalled] = useState(false)
  useEffect(() => {
    let canceled = false
    void cliStatus().then(next => { if (!canceled) setStatus(next) }).catch(() => {})
    return () => { canceled = true }
  }, [])
  const run = async (action: 'install' | 'uninstall' | 'remove') => {
    setBusy(action)
    try {
      const next = action === 'install' ? await installCli() : action === 'uninstall' ? await uninstallCli() : await removeOtherCli(status?.resolved ?? '')
      setStatus(next)
      setJustInstalled(action !== 'uninstall' && next.installed)
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      if (text !== 'canceled') toast.error({ install: 'Unable to install the command', uninstall: 'Unable to uninstall the command', remove: 'Unable to remove the older command' }[action], { description: text })
    } finally { setBusy(null) }
  }
  if (!status) return <Row title="Terminal command" description="Checking…" />
  if (status.method === 'unavailable') return <Row title="Terminal command" description={status.problem ?? 'Not available in this build.'} />
  // Shorter, familiar paths in a terminal context: ~/.local/bin/kybern.
  const tidy = (file: string) => status.home && (file.startsWith(`${status.home}/`) || file.startsWith(`${status.home}\\`)) ? `~${file.slice(status.home.length)}` : file
  const where = tidy(status.target ?? '')
  // The Windows installer and Linux packages own the command: say whether it is on PATH, offer nothing to install or remove.
  if (status.method === 'path' || status.method === 'package') {
    const copy = managedCliCopy(status.method === 'path' ? 'installer' : 'package') ?? ''
    return <DetailRow title="Terminal command" testId="about-cli" lines={[{ text: status.installed ? `Installed at ${where}. It updates with the app.` : copy }, ...(status.problem ? [{ text: status.problem, tone: 'warning' as const }] : [])]} />
  }
  const description = status.installed ? `Installed at ${where}. It updates with the app.` : 'Run Kybern from a terminal with kybern. It stays in step with the app.'
  const other = status.resolved && (status.shadowed || !status.installed) ? status.resolved : null
  const otherVersion = status.resolved_version ? `kybern ${status.resolved_version}` : 'another kybern'
  const notes: Line[] = []
  if (status.problem) notes.push({ text: status.problem, tone: 'warning' })
  if (status.installed && status.shadowed && other) notes.push({ text: `Terminals still run ${otherVersion} at ${tidy(other)}, which comes first on your PATH.`, tone: 'warning' })
  else if (!status.installed && other) notes.push({ text: `Terminals currently run ${otherVersion} at ${tidy(other)}.` })
  if (status.installed && !status.target_on_path) notes.push({ text: `Add ${tidy(status.target ?? '').replace(/[\\/][^\\/]+$/, '')} to your PATH to use it.`, tone: 'warning' })
  else if (justInstalled && !status.shadowed) notes.push({ text: 'Open a new terminal window to use it.' })
  const canInstall = !status.installed && !status.problem
  return <DetailRow title="Terminal command" testId="about-cli" lines={[{ text: description }, ...notes]}>
      {status.installed && status.shadowed && other && <Button testId="cli-remove-other" disabled={busy !== null} onClick={() => void run('remove')}>{busy === 'remove' ? 'Removing…' : 'Remove older copy'}</Button>}
      {canInstall && <Button testId="cli-install" variant="primary" disabled={busy !== null} onClick={() => void run('install')}>{busy === 'install' ? 'Installing…' : status.needs_admin ? 'Install…' : 'Install'}</Button>}
      {status.installed && <Button testId="cli-uninstall" disabled={busy !== null} onClick={() => void run('uninstall')}>{busy === 'uninstall' ? 'Uninstalling…' : 'Uninstall'}</Button>}
  </DetailRow>
}
