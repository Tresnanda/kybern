import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { motion, useWindowSize, type InputProps } from '@gpuix/react'
import { parsePairingInvitation, pairingInvitation } from '../../../../packages/kybern-client/src/address.ts'
import type { Exposure, PairingCreateResult, TokenInfo } from '../../../../packages/kybern-client/src/types.ts'
import { Dialog } from '../nav/overlay.tsx'
import { Button, Switch, TextField } from '../settings/controls.tsx'
import { activeEnvironment, onEnvironmentChange } from '../shell/environment.ts'
import { getClient } from '../state.ts'
import { EASE_OUT, REDUCED_MOTION, ink, Label, useTheme } from '../ui.tsx'
import { copyText, errorText } from '../transcript/store.ts'
import { toast } from '../shell/toasts.tsx'
import { connectEnvironment, forgetEnvironment, saveEnvironment, setupSshEnvironment } from './actions.ts'
import { localProfile, readRegistry, type EnvironmentProfile } from './registry.ts'
import { pairingQrSvg } from './qr.ts'
import { Delete02Icon } from '@hugeicons/core-free-icons'
import { glyph, Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { listSshHosts, type BootstrapProgress, type BootstrapStep } from './ssh.ts'
import { MatrixLoader } from '../MatrixLoader.tsx'
import { FONT_MONO } from '../theme.ts'

type Screen = { kind: 'add'; profile?: EnvironmentProfile } | { kind: 'manage' | 'pair' }
let screen: Screen | null = null
const listeners = new Set<() => void>()
export function showEnvironmentDialog(next: Screen | null) { screen = next; for (const listener of listeners) listener() }
onEnvironmentChange(() => showEnvironmentDialog(null))
export function EnvironmentDialogs() {
  const value = useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn) } }, () => screen)
  if (!value) return null
  const close = () => showEnvironmentDialog(null)
  return <Dialog onClose={close} width={512} testId="environment-dialog">
    {value.kind === 'add' ? <EnvironmentForm key={value.profile?.id ?? 'new'} profile={value.profile} close={close} /> : value.kind === 'manage' ? <Manage close={close} /> : <DeviceAccess close={close} />}
  </Dialog>
}

function DialogHeader({ title, description, onClose }: { title: string; description: string; onClose: () => void }) {
  const t = useTheme()
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 16, paddingRight: 40, paddingTop: 16, paddingBottom: 4, position: 'relative' }}>
    <Label color={t.text} size={16} lineHeight={20} weight={600}>{title}</Label>
    <Label color={t.textSecondary} size={14} lineHeight={21.7}>{description}</Label>
    <IconButton testId="dialog-close" label="Close" icon={N.x} onClick={onClose} style={{ position: 'absolute', top: 8, right: 8 }} />
  </div>
}
function IconButton({ testId, label, icon, onClick, style = {} }: { testId: string; label: string; icon: string; onClick: () => void; style?: object }) {
  const t = useTheme()
  return <div testId={testId} role="button" aria-label={label} tabIndex={0} onClick={onClick} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') onClick() }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, flexShrink: 0, borderRadius: 8, cursor: 'pointer', hover: { backgroundColor: t.buttonSecondaryHover }, ...style }}><Icon source={icon} size={14} color={t.textSecondary} /></div>
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  const t = useTheme()
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><Label color={ink(t, .8)} size={13} weight={500}>{label}</Label>{children}</div>
}
function EnvironmentInput(props: Parameters<typeof TextField>[0]) {
  const t = useTheme()
  return <TextField {...props} style={{ height: 32, paddingLeft: 12, paddingRight: 12, fontSize: 14, backgroundColor: t.variant === 'dark' ? ink(t, .025) : t.v('--background'), ...props.style }} />
}
function Hint({ children }: { children: ReactNode }) {
  const t = useTheme()
  return <Label color={t.textSecondary} size={13} lineHeight={20.15}>{children}</Label>
}
function Disclosure({ label, open, toggle }: { label: string; open: boolean; toggle: () => void }) {
  const t = useTheme()
  return <div testId={label === 'Advanced' ? 'environment-advanced' : 'environment-token-toggle'} role="button" tabIndex={0} aria-expanded={open} onClick={toggle} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') toggle() }} style={{ display: 'flex', alignItems: 'center', alignSelf: 'flex-start', gap: 4, paddingTop: 4, paddingBottom: 4, cursor: 'pointer' }}><Icon source={open ? N.chevronDown : N.chevronRight} size={12} color={t.textSecondary} /><Hint>{label}</Hint></div>
}
function EnvironmentForm({ profile, close }: { profile?: EnvironmentProfile; close: () => void }) {
  const initialMode = profile && !profile.ssh ? 'address' : 'ssh'
  const [selection, setSelection] = useState({ mode: initialMode, previous: initialMode, keyboard: false })
  const { mode } = selection
  const chooser = !profile && <EnvironmentChooser {...selection} onChange={(next, keyboard) => setSelection({ mode: next, previous: mode, keyboard })} />
  return mode === 'ssh' ? <SshForm profile={profile} close={close} chooser={chooser} /> : <AddressForm profile={profile} close={close} chooser={chooser} />
}
function EnvironmentChooser({ mode, previous, keyboard, onChange }: { mode: string; previous: string; keyboard: boolean; onChange: (mode: string, keyboard: boolean) => void }) {
  const t = useTheme()
  return <div role="tablist" aria-label="How to reach the machine" style={{ display: 'flex', position: 'relative', padding: 4, height: 40, width: '100%', gap: 4, borderRadius: 8, backgroundColor: t.buttonSecondary }}>
    <motion.div initial={{ translateX: previous === 'ssh' ? 0 : 237 }} animate={{ translateX: mode === 'ssh' ? 0 : 237 }} transition={{ duration: keyboard || REDUCED_MOTION ? 0 : .22, ease: EASE_OUT }} style={{ position: 'absolute', top: 4, left: 4, width: 233, height: 32, borderRadius: 6, backgroundColor: t.v('--sidebar-accent-active'), pointerEvents: 'none' }} />
    {[['ssh','Over SSH'],['address','Address or invitation']].map(([id,label]) => <div key={id} testId={`environment-tab-${id}`} role="tab" aria-selected={mode === id} tabIndex={0} onClick={() => onChange(id!, false)} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') onChange(id!, true) }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 233, height: 32, cursor: 'pointer' }}><Label color={mode === id ? t.text : t.textSecondary} size={14} weight={500}>{label}</Label></div>)}
  </div>
}
const BOOTSTRAP_STEPS: { id: BootstrapStep; label: string }[] = [{ id: 'connect', label: 'Connect over SSH' }, { id: 'install', label: 'Install kybernd' }, { id: 'start', label: 'Start the daemon' }, { id: 'pair', label: 'Pair this device' }]
function SshForm({ profile, close, chooser }: { profile?: EnvironmentProfile; close: () => void; chooser: ReactNode }) {
  const t = useTheme()
  const [name, setName] = useState(profile?.name ?? '')
  const [target, setTarget] = useState(profile?.ssh ? `${profile.ssh.target}${profile.ssh.port ? `:${profile.ssh.port}` : ''}` : '')
  const [dataDir, setDataDir] = useState(profile?.ssh?.data_dir ?? '')
  const [hosts, setHosts] = useState<string[]>([])
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  const [steps, setSteps] = useState<Partial<Record<BootstrapStep, BootstrapProgress>>>({})
  const [error, setError] = useState('')
  useEffect(() => { let live = true; void listSshHosts(process.env.KYBERN_SSH_CONFIG).then(found => { if (live) setHosts(found) }); return () => { live = false } }, [])
  const submit = async () => {
    if (busy) return
    setBusy(true); setError(''); setSteps({}); controller.current = new AbortController()
    try { const saved = await setupSshEnvironment({ id: profile?.id, name, target, data_dir: dataDir }, progress => setSteps(old => ({ ...old, [progress.step]: progress })), controller.current.signal); await connectEnvironment(saved.id); close() }
    catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  return <>
    <DialogHeader title={profile ? 'Edit environment' : 'Add environment'} description="Switch between machines. Each keeps its own projects and threads." onClose={close} />
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: 12 }}>
      {chooser}
      <Field label="Name"><EnvironmentInput testId="environment-name" label="Name" autoFocus value={name} onChange={setName} width="100%" readOnly={busy} placeholder="Dev server" /></Field>
      <Field label="Machine"><EnvironmentInput testId="environment-machine" label="SSH machine" value={target} onChange={setTarget} width="100%" readOnly={busy} placeholder="user@host" onSubmit={() => { if (name.trim() && target.trim()) void submit() }} />
        {!!target && hosts.some(host => host.startsWith(target) && host !== target) && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>{hosts.filter(host => host.startsWith(target) && host !== target).slice(0, 4).map(host => <Button key={host} variant="ghost" testId={`ssh-host-${host}`} onClick={() => setTarget(host)}>{host}</Button>)}</div>}
      </Field>
      <Hint>Kybern signs in with your SSH keys, never a password, installs and starts the daemon there, and pairs this device through a tunnel it keeps open. Aliases from ~/.ssh/config and host:port work too.</Hint>
      <Disclosure label="Advanced" open={advanced} toggle={() => setAdvanced(!advanced)} />
      {advanced && <Field label="Data directory on that machine (optional)"><EnvironmentInput testId="environment-data-dir" label="Data directory on that machine (optional)" value={dataDir} onChange={setDataDir} width="100%" readOnly={busy} placeholder="~/.kybern" /></Field>}
      {!!Object.keys(steps).length && <div testId="environment-setup-progress" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: t.border }}>{BOOTSTRAP_STEPS.map(step => <div key={step.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}><div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16 }}>{steps[step.id]?.state === 'running' ? <MatrixLoader rgb={[128,128,128]} /> : steps[step.id]?.state === 'done' ? <Icon source={N.check} size={14} color={t.green} /> : <div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: steps[step.id]?.state === 'failed' ? t.red : t.textTertiary }} />}</div><div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}><Label color={steps[step.id] ? t.text : t.textSecondary} size={13}>{step.label}</Label>{steps[step.id]?.detail && steps[step.id]?.state !== 'failed' && <Hint>{steps[step.id]!.detail}</Hint>}</div></div>)}</div>}
      {error && <div testId="environment-setup-error"><Label color={t.red} size={13} lineHeight={20.15}>{error}</Label></div>}
    </div>
    <div style={{ display: 'flex', justifyContent: 'flex-end', paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: 12 }}><Button variant="primary" testId="environment-save" disabled={busy || !name.trim() || !target.trim()} onClick={() => void submit()}>{busy ? 'Setting up' : profile ? 'Set up again and connect' : 'Set up and connect'}</Button></div>
  </>
}
function AddressForm({ profile, close, chooser }: { chooser: ReactNode } & { profile?: EnvironmentProfile; close: () => void }) {
  const t = useTheme()
  const [name, setName] = useState(profile?.name ?? '')
  const [address, setAddress] = useState(profile?.url ?? '')
  const [code, setCode] = useState('')
  const [token, setToken] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true); setError('')
    try {
      const saved = await saveEnvironment({ id: profile?.id, name, address, code, token })
      await connectEnvironment(saved.id); close()
    } catch (e) { setError(errorText(e)); setBusy(false) }
  }
  const invited = parsePairingInvitation(address)
  return <>
    <DialogHeader title={profile ? 'Edit environment' : 'Add environment'} description="Switch between machines. Each keeps its own projects and threads." onClose={close} />
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: 12 }}>
      {chooser}
      <Field label="Name"><EnvironmentInput testId="environment-name" autoFocus label="Name" value={name} onChange={setName} width="100%" readOnly={busy} placeholder="Dev server" /></Field>
      <Field label="Address or pairing invitation"><EnvironmentInput testId="environment-address" label="Address or pairing invitation" value={address} onChange={(value) => { setAddress(value); if (parsePairingInvitation(value)) setToken('') }} width="100%" readOnly={busy} placeholder="https://machine.example.ts.net" /></Field>
      <Field label={`Pairing code${profile ? ' (optional)' : ''}`}><EnvironmentInput testId="environment-code" label="Pairing code" value={invited?.code ?? code} onChange={(value) => { setCode(value.replace(/\D/g, '').slice(0, 6)); setToken('') }} style={{ fontFamily: FONT_MONO }} width="100%" readOnly={busy || !!invited} placeholder="000000" /></Field>
      <Label color={t.textSecondary} size={13} lineHeight={20.15}>{profile ? 'Leave the code empty to keep this device’s access.' : 'On the other machine, choose Pair a device in the environment menu. For a server or VPS, run kybern pair over SSH.'}</Label>
      <Disclosure label="Use an existing device token" open={advanced} toggle={() => setAdvanced(!advanced)} />
      {advanced && <Field label="Device token"><EnvironmentInput {...({ secure: true } as InputProps)} testId="environment-token" label="Device token" value={token} onChange={value => { setToken(value); setCode('') }} width="100%" readOnly={busy} placeholder="Device token" /></Field>}
      {error && <Label color={t.red} size={12} lineHeight={18}>{error}</Label>}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}><Button variant="primary" testId="environment-save" disabled={busy || !name.trim() || !address.trim() || (!profile && !invited && code.length !== 6 && !token.trim())} onClick={() => void submit()}>{busy ? 'Connecting' : 'Save and connect'}</Button></div>
    </div>
  </>
}

function Manage({ close }: { close: () => void }) {
  const t = useTheme()
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  const profiles = useMemo(() => { try { return [localProfile, ...readRegistry().environments] } catch { return [localProfile] } }, [revision])
  return <>
    <DialogHeader title="Manage environments" description="Edit a connection or remove it from this device. Work on that machine keeps running." onClose={close} />
    <virtual-list testId="environment-manage-list" style={{ width: '100%', height: Math.min(360, profiles.length * 69 + 28) }}>
      {profiles.map((profile, index) => <div key={profile.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, paddingLeft: 16, paddingRight: 16, paddingTop: index ? 12 : 24, paddingBottom: index === profiles.length - 1 ? 28 : 12 }}>
        <Icon source={N.globe} size={16} color={t.textSecondary} style={{ marginTop: 4 }} />
        <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}><Label color={t.text} size={14} lineHeight={21.7}>{profile.name}</Label><Hint>{profile.ssh ? `ssh ${profile.ssh.target}${profile.ssh.port ? `:${profile.ssh.port}` : ''}` : profile.url ?? profile.hostname ?? getClient()?.info?.hostname ?? 'Managed by Kybern'}</Hint></div>
        {profile.id !== 'local' && <><IconButton testId={`environment-edit-${profile.id}`} label={`Edit ${profile.name}`} icon={N.pencil} onClick={() => showEnvironmentDialog({ kind: 'add', profile })} /><IconButton testId={`environment-forget-${profile.id}`} label={`Remove ${profile.name}`} icon={glyph(Delete02Icon)} onClick={() => { try { forgetEnvironment(profile.id); setRevision(n => n + 1) } catch (e) { setError(errorText(e)) } }} /></>}
      </div>)}
    </virtual-list>
    {error && <Label color={t.red} size={12} style={{ padding: 16 }}>{error}</Label>}
  </>
}

export function isLoopbackAddress(address: string) {
  try { const host = new URL(address).hostname.replace(/^\[|\]$/g, ''); return host === 'localhost' || host === '::1' || /^127\./.test(host) } catch { return false }
}
function DeviceAccess({ close }: { close: () => void }) {
  const t = useTheme()
  const size = useWindowSize({ intervalMs: 250 })
  const [client] = useState(() => getClient()!)
  const [exposure, setExposure] = useState<Exposure | null>(null)
  const [devices, setDevices] = useState<TokenInfo[]>([])
  const [invitation, setInvitation] = useState<PairingCreateResult | null>(null)
  const [address, setAddress] = useState('')
  const [expired, setExpired] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let live = true
    void client.call('access.exposure.get', {}).then((value) => { if (live) setExposure(value) }, () => {})
    void client.call('access.tokens.list', {}).then((value) => { if (live) setDevices(value.tokens) }, (e) => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [client, reload])
  useEffect(() => {
    if (!invitation) return
    const left = Date.parse(invitation.expires_at) - Date.now()
    setExpired(left <= 0)
    if (left <= 0) return
    const timer = setTimeout(() => setExpired(true), left)
    return () => clearTimeout(timer)
  }, [invitation])
  const link = useMemo(() => { try { return invitation && address && client.info ? pairingInvitation(address, invitation.code, client.info.environment_id) : null } catch { return null } }, [invitation, address, client])
  const qr = useMemo(() => { if (!link || expired || isLoopbackAddress(address)) return null; try { return pairingQrSvg(link) } catch { return null } }, [link, expired, address])
  const create = async (nextExposure = exposure) => {
    const next = await client.call('access.pairing.create', {})
    setInvitation(next)
    const remote = next.endpoints.filter((url) => !isLoopbackAddress(url))
    setAddress(remote.find((url) => nextExposure?.tailscale_ip && url.includes(nextExposure.tailscale_ip)) ?? remote[0] ?? (!isLoopbackAddress(client.endpoint.url) ? client.endpoint.url : ''))
  }
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); try { await action() } catch (e) { setError(errorText(e)) } finally { setBusy(false) } }
  return <>
    <DialogHeader title="Pair a device" description={`Give another device access to ${activeEnvironment().name}.`} onClose={close} />
    <div testId="environment-access-body" style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: 16, maxHeight: size.height - 125, minHeight: 0, flexShrink: 1, overflowY: 'scroll' }}>
      {exposure && <div style={{ display: 'flex', alignItems: 'center', gap: 16, borderRadius: 12, backgroundColor: ink(t, .016), paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: 12 }}><div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexGrow: 1, minWidth: 0 }}><Label color={t.text} size={14} weight={500}>Reachable over Tailscale</Label><Hint>{exposure.tailscale_ip ? exposure.tailscale ? `Devices on your tailnet connect to ${exposure.tailscale_ip} directly.` : 'Lets phones and other devices on your tailnet pair without a tunnel.' : 'Tailscale is not running on this machine.'}</Hint></div><Switch testId="environment-tailscale" label="Reachable over Tailscale" checked={exposure.tailscale} disabled={busy || (!exposure.tailscale && !exposure.tailscale_ip)} onChange={tailscale => void run(async () => { const value = await client.call('access.exposure.set', { tailscale }); setExposure(value); if (invitation) await create(value) })} /></div>}
      {invitation && <>
        {qr && <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}><div role="img" aria-label="Pairing QR code" style={{ width: 176, height: 176, padding: 12, borderRadius: 12, backgroundColor: '#ffffff' }}><svg testId="pairing-qr" source={qr} style={{ width: 152, height: 152, color: '#000000' }} /></div><Hint>Scan with the Kybern mobile app, or copy the invitation below.</Hint></div>}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, borderRadius: 12, backgroundColor: ink(t, .016), padding: 16 }}><Label color={t.text} size={30} lineHeight={36} style={{ fontFamily: FONT_MONO }}>{invitation.code.split('').join(' ')}</Label><Hint>{expired ? 'Code expired. Create a new invitation.' : `Use once before ${new Date(invitation.expires_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}</Hint></div>
        <Field label="Connection address"><EnvironmentInput testId="pairing-address" label="Connection address" value={address} onChange={setAddress} width="100%" placeholder="https://machine.example.ts.net" /></Field>
        {(!address || isLoopbackAddress(address)) && <Hint>{address ? `This address only works on the machine itself.${exposure?.tailscale_ip && !exposure.tailscale ? ' Turn on Reachable over Tailscale to get one other devices can use.' : ' Enter an address the other device can reach.'}` : 'Enter an address the other device can reach, such as your Tailscale HTTPS address or SSH tunnel address.'}</Hint>}
        <Button variant="primary" testId="pairing-copy" disabled={!link || expired} onClick={() => { if (link) { copyText(link); toast('Copied pairing invitation') } }}>Copy invitation</Button>
      </>}
      <Button variant={invitation && !expired ? 'secondary' : 'primary'} testId="pairing-create" disabled={busy} onClick={() => void run(() => create())}>{invitation ? 'Create new invitation' : 'Create pairing invitation'}</Button>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 16 }}><Label color={t.text} size={14} weight={500}>Paired devices</Label>
        {!devices.filter(d => d.label !== 'bootstrap').length && <div style={{ paddingTop: 8, paddingBottom: 8 }}><Hint>Create an invitation, then open it on the device you want to connect.</Hint></div>}
        {devices.filter(d => d.label !== 'bootstrap').map(device => <div key={device.id} style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 8, paddingBottom: 8 }}><Label color={t.text} size={13} lineHeight={20.15} style={{ flexGrow: 1, minWidth: 0 }}>{device.label}</Label>{device.revoked ? <Hint>Revoked</Hint> : <Button variant="ghost" testId={`revoke-${device.id}`} disabled={busy} onClick={() => void run(async () => { await client.call('access.tokens.revoke', { token_id: device.id }); setDevices(list => list.map(d => d.id === device.id ? { ...d, revoked: true } : d)) })}>Revoke access</Button>}</div>)}
      </div>
      {error && <Label color={t.red} size={13} lineHeight={20.15}>{error}</Label>}
    </div>
  </>
}
