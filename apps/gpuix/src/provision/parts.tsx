// The pieces the "Add to another machine" sheet, the agent card and the fork sheet share: the plan hook (asked of the SOURCE
// machine, re-checked on the target as the folder changes), the folder field with its inline chooser (it browses the TARGET
// machine's folders with `projects.browse` on that machine's own connection) and the env file list.
import { useEffect, useRef, useState } from 'react'
import type { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import type { PathCheck, ProjectsBrowseResult, ProvisionPlan } from '../../../../packages/kybern-client/src/types.ts'
import { PROVISION_COPY as COPY, baseName, displayPath, formatSize, joinPath, pathAccepted } from '../../../../packages/kybern-client/src/provision.ts'
import { Button } from '../kit/Button.tsx'
import { Checkbox } from '../kit/Checkbox.tsx'
import { TextField } from '../kit/Field.tsx'
import { RADIUS, useControls } from '../kit/controls.ts'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { errorText } from '../nav/actions.ts'
import { machineHub } from '../machines/index.ts'
import { fixtureClient } from './targets.ts'
import { Label, useTheme } from '../ui.tsx'
import { FONT_MONO } from '../theme.ts'

/** The plan for `projectId` going to `machineId`, asked of `source`; `path` is re-checked by the target 300 ms after it settles. */
export function useProvisionPlan(source: KybernClient | null, projectId: string, machineId: string | null, path: string | null, initial?: ProvisionPlan, retry = 0) {
  const [plan, setPlan] = useState<ProvisionPlan | null>(initial ?? null)
  const [checkedPlan, setCheckedPlan] = useState<ProvisionPlan | null>(null)
  const [check, setCheck] = useState<PathCheck | null>(initial?.path_check ?? null)
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    // A plan the daemon already sent (the agent card) is used as it is; only the folder is checked again.
    if (initial) return
    setPlan(null); setCheckedPlan(null); setCheck(null); setError(''); setChecking(false)
    if (!source || !machineId) return
    let live = true
    source.call('projects.provision_plan', { project_id: projectId, machine: machineId }).then(
      (next) => { if (live) { setPlan(next); setCheck(next.path_check ?? null) } },
      (e) => { if (live) setError(errorText(e)) },
    )
    return () => { live = false }
  }, [source, projectId, machineId, retry])
  const asked = useRef(0)
  useEffect(() => {
    if (!source || !machineId || !plan || path === null || path === (plan.path_check?.path ?? '')) return
    const attempt = ++asked.current
    setChecking(true)
    const timer = setTimeout(() => {
      source.call('projects.provision_plan', { project_id: projectId, machine: machineId, path }).then(
        (next) => { if (attempt === asked.current) { setCheckedPlan(next); setCheck(next.path_check ?? null); setChecking(false) } },
        (e) => { if (attempt === asked.current) { setCheck({ state: 'forbidden', path, message: errorText(e) }); setChecking(false) } },
      )
    }, 300)
    return () => { clearTimeout(timer); asked.current++ }
  }, [source, projectId, machineId, plan, path])
  return { plan: checkedPlan ?? plan, check, checking, error }
}

/** The target's client, for browsing its folders. Null while it is offline. */
export function targetClient(machineId: string | null | undefined): KybernClient | null {
  if (!machineId) return null
  try { return fixtureClient() ?? machineHub().clientFor(machineId) } catch { return null }
}

/** Where the project goes: an editable path, the target's verdict under it, and "Choose…" opening that machine's folders in place. */
export function FolderField({ plan, path, onPath, check, checking, disabled, testId = 'provision-folder' }: {
  plan: ProvisionPlan; path: string; onPath: (path: string) => void; check: PathCheck | null; checking: boolean; disabled: boolean; testId?: string
}) {
  const t = useTheme()
  const [choosing, setChoosing] = useState(false)
  const online = plan.target.online
  const tone = !check || checking ? t.textSecondary : pathAccepted(check) ? t.textSecondary : t.red
  const spelled = check?.path ? displayPath(check.path, plan.target_home, plan.target.os) : ''
  const shown = spelled && spelled !== path && check?.path !== path ? spelled : null
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <TextField testId={testId} size="lg" mono label={`Folder on ${plan.target.name}`} value={path} placeholder={online ? '' : '~/projects/name'} disabled={disabled} onChange={onPath} width="100%" />
      <Button size="lg" variant="secondary" testId={`${testId}-choose`} disabled={disabled || !online} onClick={() => setChoosing((open) => !open)}>{COPY.choose}</Button>
    </div>
    <div testId={`${testId}-check`} style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 20 }}>
      {check && !checking && <div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: pathAccepted(check) ? (check.state === 'unknown' ? t.textTertiary : t.green) : t.red }} />}
      <Label color={tone} size={12.5} lineHeight={18} truncate>{checking ? `Checking on ${plan.target.name}…` : check ? (shown ? `${check.message} · ${shown}` : check.message) : online ? '' : `${plan.target.name} is offline · it picks the folder when it returns`}</Label>
    </div>
    {choosing && <FolderChooser plan={plan} start={path} disabled={disabled} onCancel={() => setChoosing(false)} onPick={(parent) => { onPath(joinPath(parent, baseName(path) || plan.project_name, plan.target.os)); setChoosing(false) }} />}
  </div>
}

/** The target's folders, one level at a time; the chosen folder becomes the parent of the project's folder. */
function FolderChooser({ plan, start, disabled, onPick, onCancel }: { plan: ProvisionPlan; start: string; disabled: boolean; onPick: (parent: string) => void; onCancel: () => void }) {
  const t = useTheme()
  const c = useControls()
  const [client] = useState(() => targetClient(plan.target.id))
  const [listing, setListing] = useState<ProjectsBrowseResult | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const sequence = useRef(0)
  const browse = async (path?: string) => {
    if (!client) return
    const attempt = ++sequence.current
    setBusy(true); setError('')
    try { const next = await client.call('projects.browse', path ? { path } : {}); if (attempt === sequence.current) setListing(next) }
    catch (e) {
      // The proposed parent may not exist yet: start in the machine's home instead.
      if (attempt === sequence.current) { if (path) return browse(); setError(errorText(e)) }
    }
    finally { if (attempt === sequence.current) setBusy(false) }
  }
  // Start in the folder the proposed path sits in (its parent), else the target's home.
  useEffect(() => {
    const parent = start.replace(/[\\/][^\\/]*[\\/]?$/, '')
    void browse(parent || undefined)
    return () => { sequence.current++ }
  }, [client])
  const name = baseName(start) || plan.project_name
  const here = listing ? displayPath(listing.path, plan.target_home, plan.target.os) : ''
  return <div testId="provision-chooser" style={{ display: 'flex', flexDirection: 'column', borderWidth: 1, borderColor: c.ink(0.1), borderRadius: RADIUS.lg, overflow: 'hidden' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 10, paddingRight: 6, height: 36, backgroundColor: c.ink(0.03) }}>
      <Icon source={N.folderOpen} size={14} color={t.textSecondary} />
      <Label color={t.text} size={13} lineHeight={18} weight={500} truncate style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}>{here || `${plan.target.name}`}</Label>
      {listing?.parent && <Button size="sm" variant="ghost" testId="provision-chooser-up" disabled={busy || disabled} onClick={() => void browse(listing.parent!)}>Up</Button>}
    </div>
    <virtual-list testId="provision-chooser-folders" style={{ height: 196, width: '100%', paddingTop: 4, paddingBottom: 4, paddingLeft: 4, paddingRight: 4 }}>
      {listing?.directories.map((directory) => <div key={directory.path}><ChooserRow name={directory.name} disabled={busy || disabled} onClick={() => void browse(directory.path)} /></div>)}
      {busy && <div key="loading" style={{ padding: 10 }}><Label color={t.textSecondary} size={12.5}>{`Loading folders on ${plan.target.name}…`}</Label></div>}
      {!busy && listing?.directories.length === 0 && <div key="empty" style={{ padding: 10 }}><Label color={t.textSecondary} size={12.5}>No folders here.</Label></div>}
      {!busy && error && <div key="error" style={{ padding: 10 }}><Label color={t.red} size={12.5}>{error}</Label></div>}
    </virtual-list>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 10, paddingRight: 6, paddingTop: 6, paddingBottom: 6, borderTopWidth: 1, borderColor: c.ink(0.08) }}>
      <Label color={t.textSecondary} size={12.5} lineHeight={18} truncate style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}>{listing ? `Creates ${displayPath(joinPath(listing.path, name, plan.target.os), plan.target_home, plan.target.os)}` : ''}</Label>
      <Button size="sm" variant="ghost" testId="provision-chooser-cancel" onClick={onCancel}>Cancel</Button>
      <Button size="sm" variant="primary" testId="provision-chooser-use" disabled={!listing || busy || disabled} onClick={() => listing && onPick(listing.path)}>Put it here</Button>
    </div>
  </div>
}

function ChooserRow({ name, onClick, disabled }: { name: string; onClick: () => void; disabled: boolean }) {
  const t = useTheme()
  const c = useControls()
  return <div tabIndex={disabled ? -1 : 0} role="button" aria-label={`Open ${name}`} onClick={() => { if (!disabled) onClick() }} onKeyDown={(e) => { if (!disabled && (e.key === 'enter' || e.key === 'space')) onClick() }}
    style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 30, paddingLeft: 8, paddingRight: 8, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: c.ink(0.05) }, focusVisible: { outlineWidth: 2, outlineColor: c.focus, outlineOffset: -2 } }}>
    <Icon source={N.folder} size={14} color={t.textSecondary} />
    <Label color={t.text} size={13} lineHeight={18} truncate>{name}</Label>
  </div>
}

/** The git-ignored env files with a box each; names and sizes only. */
export function EnvFileList({ plan, selected, onChange, disabled, testId = 'provision-env' }: { testId?: string; plan: ProvisionPlan; selected: readonly string[]; onChange: (files: string[]) => void; disabled: boolean }) {
  const t = useTheme()
  const c = useControls()
  if (plan.env_files.length === 0) return <Label color={t.textSecondary} size={13} lineHeight={20}>{COPY.noEnvFiles}</Label>
  const toggle = (path: string, on: boolean) => onChange(on ? [...selected, path] : selected.filter((item) => item !== path))
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    <div testId={testId} style={{ display: 'flex', flexDirection: 'column', borderWidth: 1, borderColor: c.ink(0.08), borderRadius: RADIUS.lg, paddingTop: 2, paddingBottom: 2 }}>
      {plan.env_files.map((file) => {
        const on = selected.includes(file.path)
        return <div key={file.path} onClick={disabled ? undefined : () => toggle(file.path, !on)} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 32, paddingLeft: 10, paddingRight: 12, cursor: disabled ? 'default' : 'pointer' }}>
          <Checkbox testId={`${testId}-${file.path}`} aria-label={file.path} checked={on} disabled={disabled} onCheckedChange={(next) => toggle(file.path, next)} />
          <Label color={t.text} size={13} lineHeight={18} font={FONT_MONO} truncate style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}>{file.path}</Label>
          <Label color={t.textTertiary} size={12} lineHeight={16}>{formatSize(file.size)}</Label>
        </div>
      })}
    </div>
    <Label color={t.textSecondary} size={12.5} lineHeight={18}>{COPY.envHint}</Label>
  </div>
}

/** A thin bar: determinate when the bytes are known, a quiet full track otherwise (the line above says what happens). */
export function ProgressBar({ fraction, failed = false }: { fraction: number | null; failed?: boolean }) {
  const t = useTheme()
  const c = useControls()
  return <div testId="provision-progress" style={{ height: 4, borderRadius: 2, backgroundColor: c.ink(0.08), overflow: 'hidden' }}>
    <div style={{ height: 4, borderRadius: 2, width: `${Math.round((fraction ?? 0.35) * 100)}%`, backgroundColor: failed ? t.red : c.accent, opacity: fraction === null && !failed ? 0.55 : 1 }} />
  </div>
}
