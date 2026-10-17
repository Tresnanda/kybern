import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { parsePairingInvitation, pairingInvitation, normalizeDaemonUrl } from '../../../../packages/kybern-client/src/address.ts'
import type { Exposure, PairingCreateResult, TokenInfo } from '../../../../packages/kybern-client/src/types.ts'
import { Dialog } from '../nav/overlay.tsx'
import { Switch } from '../settings/controls.tsx'
import { activeEnvironment, onEnvironmentChange } from '../shell/environment.ts'
import { getClient } from '../state.ts'
import { motion } from '@gpuix/react'
import { EASE_OUT, ink, Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { copyText, errorText } from '../transcript/store.ts'
import { toast } from '../shell/toasts.tsx'
import { connectEnvironment, forgetEnvironment, saveEnvironment, setupSshEnvironment } from './actions.ts'
import { localProfile, readRegistry, type EnvironmentProfile } from './registry.ts'
import { pairingQrSvg } from './qr.ts'
import { Delete02Icon } from '@hugeicons/core-free-icons'
import { glyph, Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { listSshHosts, type BootstrapProgress, type BootstrapStep } from './ssh.ts'
import { FONT_MONO } from '../theme.ts'
import { DialogBody, DialogFooter, DialogHeader, Disclosure, EnvButton, EnvInput, ErrorText, Field, Hint, IconButton, Spinner } from './kit.tsx'

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

function EnvironmentForm({ profile, close }: { profile?: EnvironmentProfile; close: () => void }) {
  const initialMode = profile && !profile.ssh ? 'address' : 'ssh'
  const [selection, setSelection] = useState({ mode: initialMode, previous: initialMode, keyboard: false })
  const [busy, setBusy] = useState(false)
  const { mode } = selection
  const chooser = !profile && <EnvironmentChooser {...selection} busy={busy} onChange={(next, keyboard) => setSelection({ mode: next, previous: mode, keyboard })} />
  return mode === 'ssh' ? <SshForm profile={profile} close={close} chooser={chooser} busy={busy} setBusy={setBusy} /> : <AddressForm profile={profile} close={close} chooser={chooser} busy={busy} setBusy={setBusy} />
}
/** The desktop's `t-tabs` sliding pill: 478px track, 4px padding, two 233px tabs of 31.5px. */
function EnvironmentChooser({ mode, previous, keyboard, busy, onChange }: { mode: string; previous: string; keyboard: boolean; busy: boolean; onChange: (mode: string, keyboard: boolean) => void }) {
  const t = useTheme()
  return <div role="tablist" aria-label="How to reach the machine" style={{ display: 'flex', position: 'relative', padding: 4, height: 39.5, width: '100%', gap: 4, borderRadius: 10, backgroundColor: t.buttonSecondary }}>
    <motion.div initial={{ translateX: previous === 'ssh' ? 0 : 237 }} animate={{ translateX: mode === 'ssh' ? 0 : 237 }} transition={{ duration: keyboard || REDUCED_MOTION ? 0 : .22, ease: EASE_OUT }} style={{ position: 'absolute', top: 4, left: 4, width: 233, height: 31.5, borderRadius: 8, backgroundColor: t.v('--sidebar-accent-active'), pointerEvents: 'none' }} />
    {[['ssh', 'Over SSH'], ['address', 'Address or invitation']].map(([id, label]) => <div key={id} testId={`environment-tab-${id}`} role="tab" aria-selected={mode === id} tabIndex={busy ? -1 : 0} onClick={() => { if (!busy) onChange(id!, false) }} onKeyDown={e => { if (!busy && (e.key === 'enter' || e.key === 'space')) onChange(id!, true) }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 233, height: 31.5, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}><Label color={mode === id ? t.v('--sidebar-accent-foreground') : t.textSecondary} size={13} lineHeight={19.5}>{label}</Label></div>)}
  </div>
}
const BOOTSTRAP_STEPS: { id: BootstrapStep; label: string }[] = [{ id: 'connect', label: 'Connect over SSH' }, { id: 'install', label: 'Install kybernd' }, { id: 'start', label: 'Start the daemon' }, { id: 'pair', label: 'Pair this device' }]
function SshForm({ profile, close, chooser, busy, setBusy }: { profile?: EnvironmentProfile; close: () => void; chooser: ReactNode; busy: boolean; setBusy: (busy: boolean) => void }) {
  const t = useTheme()
  const [name, setName] = useState(profile?.name ?? '')
  const [target, setTarget] = useState(profile?.ssh ? `${profile.ssh.target}${profile.ssh.port ? `:${profile.ssh.port}` : ''}` : '')
  const [dataDir, setDataDir] = useState(profile?.ssh?.data_dir ?? '')
  const [hosts, setHosts] = useState<string[]>([])
  const [advanced, setAdvanced] = useState(false)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  const [steps, setSteps] = useState<Partial<Record<BootstrapStep, BootstrapProgress>>>({})
  const [error, setError] = useState('')
  useEffect(() => { let live = true; void listSshHosts(process.env.KYBERN_SSH_CONFIG).then(found => { if (live) setHosts(found) }); return () => { live = false } }, [])
  const ready = !!name.trim() && !!target.trim()
  const submit = async () => {
    if (busy || !ready) return
    setBusy(true); setError(''); setSteps({}); controller.current = new AbortController()
    try {
      const saved = await setupSshEnvironment({ id: profile?.id, name, target, data_dir: dataDir }, progress => setSteps(old => ({ ...old, [progress.step]: progress })), controller.current.signal)
      await connectEnvironment(saved.id); close()
    }
    catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  const suggestions = !!target && hosts.some(host => host.startsWith(target) && host !== target) ? hosts.filter(host => host.startsWith(target) && host !== target).slice(0, 4) : []
  const host = target.trim().replace(/^ssh:\/\//, '').replace(/^[^@]*@/, '')
  return <>
    <DialogHeader title={profile ? 'Edit environment' : 'Add environment'} description="Switch between machines. Each keeps its own projects and threads." onClose={close} />
    <DialogBody footer>
      {chooser}
      <Field label="Name"><EnvInput testId="environment-name" label="Name" autoFocus value={name} onChange={setName} disabled={busy} placeholder="Dev server" onSubmit={() => void submit()} /></Field>
      <Field label="Machine"><EnvInput testId="environment-machine" label="SSH machine" value={target} onChange={setTarget} disabled={busy} placeholder="user@host" onSubmit={() => void submit()} />
        {suggestions.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>{suggestions.map(item => <EnvButton key={item} variant="ghost" size="xs" testId={`ssh-host-${item}`} onClick={() => setTarget(item)}>{item}</EnvButton>)}</div>}
      </Field>
      <Hint>Kybern signs in with your SSH keys, never a password, installs and starts the daemon there, and pairs this device through a tunnel it keeps open. Aliases from ~/.ssh/config and host:port work too.</Hint>
      <Disclosure testId="environment-advanced" label="Advanced" open={advanced} toggle={() => setAdvanced(!advanced)} />
      {advanced && <Field label="Data directory on that machine (optional)"><EnvInput testId="environment-data-dir" label="Data directory on that machine (optional)" value={dataDir} onChange={setDataDir} disabled={busy} placeholder="~/.kybern" onSubmit={() => void submit()} /></Field>}
      {!!Object.keys(steps).length && <div testId="environment-setup-progress" aria-label="Setup progress" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: ink(t, t.variant === 'dark' ? .06 : .08) }}>{BOOTSTRAP_STEPS.map(step => { const state = steps[step.id]?.state ?? 'pending'; return <div key={step.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}><div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, marginTop: 2 }}>{state === 'running' ? <Spinner /> : state === 'done' ? <Icon source={N.check} size={14} color="#10b981" /> : state === 'failed' ? <div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: t.red }} /> : <div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: ink(t, .4 * .58) }} />}</div><div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}><Label color={state === 'pending' ? t.textSecondary : t.text} size={13} lineHeight={17.5}>{step.label}</Label>{steps[step.id]?.detail && state !== 'failed' && <Hint>{steps[step.id]!.detail!}</Hint>}</div></div> })}</div>}
      {error && <div testId="environment-setup-error" role="alert" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><Label color={t.red} size={13} lineHeight={21.125}>{error}</Label>{/Permission denied|ssh-copy-id/.test(error) && !!host && <Label color={t.text} size={13} lineHeight={21.125} font={FONT_MONO}>{`ssh-copy-id ${target.trim()}`}</Label>}</div>}
    </DialogBody>
    <DialogFooter><EnvButton testId="environment-save" disabled={!ready} busy={busy} onClick={() => void submit()}>{busy ? 'Setting up' : profile ? 'Set up again and connect' : 'Set up and connect'}</EnvButton></DialogFooter>
  </>
}

/** `isLoopbackAddress` for the address a user typed, tolerant of scheme-less input. */
function isLoopback(address: string) { return isLoopbackAddress(address.includes('://') ? address : `ws://${address}`) }
function AddressForm({ profile, close, chooser, busy, setBusy }: { profile?: EnvironmentProfile; close: () => void; chooser: ReactNode; busy: boolean; setBusy: (busy: boolean) => void }) {
  const [name, setName] = useState(profile?.name ?? '')
  const [address, setAddress] = useState(profile?.url ?? '')
  const [code, setCode] = useState('')
  const [token, setToken] = useState('')
  const [expectedIdentity, setExpectedIdentity] = useState<string | undefined>(undefined)
  const [advanced, setAdvanced] = useState(false)
  const [error, setError] = useState('')
  const [addressError, setAddressError] = useState('')
  const validateAddress = () => {
    try { normalizeDaemonUrl(address); setAddressError(''); return true }
    catch { setAddressError('Enter a machine address, such as https://machine.example.ts.net.'); return false }
  }
  /** Pasting a complete invitation fills the address and the code, like the desktop. */
  const setAddressOrInvitation = (value: string) => {
    setAddressError('')
    const invitation = parsePairingInvitation(value)
    if (invitation) { setAddress(invitation.url); setCode(invitation.code); setToken(''); setExpectedIdentity(invitation.environmentId) }
    else { setAddress(value); setExpectedIdentity(undefined) }
  }
  const ready = !!name.trim() && !!address.trim() && (!!profile || code.length === 6 || !!token.trim())
  const submit = async () => {
    if (busy || !ready || !validateAddress()) return
    setBusy(true); setError('')
    try {
      const saved = await saveEnvironment({ id: profile?.id, name, address, code: code || undefined, token: token || undefined, expectedIdentity })
      await connectEnvironment(saved.id); close()
    } catch (e) {
      const detail = errorText(e)
      const unreachable = /error sending request|connection refused|timed out|Unable to connect|ConnectionRefused|fetch failed|Unable to reach/i.test(detail)
      setError(unreachable && isLoopback(address)
        ? "This invitation points at the other machine's own loopback address, which only works on that machine. For a daemon that listens on 127.0.0.1, add it over SSH instead, or bind it to an address this device can reach."
        : unreachable ? 'Unable to reach this machine. Check its address and network connection, then try again.' : detail)
    } finally { setBusy(false) }
  }
  return <>
    <DialogHeader title={profile ? 'Edit environment' : 'Add environment'} description="Switch between machines. Each keeps its own projects and threads." onClose={close} />
    <DialogBody footer>
      {chooser}
      <Field label="Name"><EnvInput testId="environment-name" autoFocus label="Name" value={name} onChange={setName} disabled={busy} placeholder="Dev server" onSubmit={() => void submit()} /></Field>
      <Field label="Address or pairing invitation"><EnvInput testId="environment-address" label="Address or pairing invitation" value={address} onChange={setAddressOrInvitation} disabled={busy} invalid={!!addressError} onBlur={() => { if (address.trim()) validateAddress() }} placeholder="https://machine.example.ts.net" onSubmit={() => void submit()} />
        {!!addressError && <ErrorText testId="environment-address-error">{addressError}</ErrorText>}</Field>
      <Field label={`Pairing code${profile ? ' (optional)' : ''}`}><EnvInput testId="environment-code" label="Pairing code" value={code} onChange={(value) => { setCode(value.replace(/\D/g, '').slice(0, 6)); setToken('') }} mono disabled={busy} placeholder="000000" onSubmit={() => void submit()} /></Field>
      <Hint>{profile ? 'Leave the code empty to keep this device’s access.' : 'On the other machine, choose Pair a device in the environment menu. For a server or VPS, run kybern pair over SSH.'}</Hint>
      <Disclosure testId="environment-token-toggle" label="Use an existing device token" open={advanced} toggle={() => setAdvanced(!advanced)} />
      {advanced && <Field label="Device token"><EnvInput secure testId="environment-token" label="Device token" value={token} onChange={value => { setToken(value); setCode('') }} disabled={busy} placeholder="Device token" onSubmit={() => void submit()} /></Field>}
      {!!error && <ErrorText testId="environment-save-error">{error}</ErrorText>}
    </DialogBody>
    <DialogFooter><EnvButton testId="environment-save" disabled={!ready} busy={busy} onClick={() => void submit()}>{busy ? 'Connecting' : 'Save and connect'}</EnvButton></DialogFooter>
  </>
}

function Manage({ close }: { close: () => void }) {
  const t = useTheme()
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const profiles = useMemo(() => { try { return [localProfile, ...readRegistry().environments] } catch { return [localProfile] } }, [revision])
  const forget = async (profile: EnvironmentProfile) => {
    setBusy(profile.id); setError('')
    try { forgetEnvironment(profile.id); setRevision(n => n + 1) } catch (e) { setError(errorText(e)) } finally { setBusy(null) }
  }
  return <>
    <DialogHeader title="Manage environments" description="Edit a connection or remove it from this device. Work on that machine keeps running." onClose={close} />
    <div testId="environment-manage-list" style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 16, paddingRight: 16, paddingBottom: 16 }}>
      {profiles.map((profile) => <div key={profile.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, paddingTop: 12, paddingBottom: 12 }}>
        <Icon source={N.globe} size={16} color={t.textSecondary} style={{ marginTop: 4 }} />
        <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}><Label color={t.text} size={14} lineHeight={22.75}>{profile.name}</Label><Hint>{profile.ssh ? `ssh ${profile.ssh.target}${profile.ssh.port ? `:${profile.ssh.port}` : ''}` : profile.url ?? profile.hostname ?? 'Managed by Kybern'}</Hint></div>
        {profile.id !== 'local' && <><IconButton testId={`environment-edit-${profile.id}`} label={`Edit ${profile.name}`} icon={N.pencil} disabled={!!busy} onClick={() => showEnvironmentDialog({ kind: 'add', profile })} /><IconButton testId={`environment-forget-${profile.id}`} label={`Remove ${profile.name}`} disabled={!!busy} onClick={() => void forget(profile)}>{busy === profile.id ? <Spinner /> : <Icon source={glyph(Delete02Icon)} size={14} color={t.textSecondary} />}</IconButton></>}
      </div>)}
      {!!error && <ErrorText testId="environment-manage-error">{error}</ErrorText>}
    </div>
  </>
}

export function isLoopbackAddress(address: string) {
  try { const host = new URL(address.trim()).hostname.replace(/^\[|\]$/g, ''); return host === 'localhost' || host === '::1' || /^127\./.test(host) } catch { return false }
}

/** The address another device should use: Tailscale first, then any other reachable endpoint, then the one this device connected with. */
export function suggestedAddress(endpoints: string[], exposure: Exposure | null, profileUrl: string | null | undefined) {
  const remote = endpoints.filter((url) => !isLoopbackAddress(url))
  const tailscale = exposure?.tailscale_ip ? remote.find((url) => url.includes(exposure.tailscale_ip!)) : undefined
  if (tailscale) return tailscale
  if (remote[0]) return remote[0]
  if (profileUrl && !isLoopbackAddress(profileUrl)) return profileUrl
  return ''
}

/** The invitation code in `font-mono text-3xl tracking-[0.25em]`: one 18px cell per digit, 7.5px apart (GPUIX text has no letter spacing). */
function CodeDigits({ code }: { code: string }) {
  const t = useTheme()
  return <div testId="pairing-code" style={{ display: 'flex', justifyContent: 'center', gap: 7.5, paddingLeft: 7.5 }}>{code.split('').map((digit, index) => <div key={index} style={{ display: 'flex', justifyContent: 'center', width: 18 }}><Label color={t.text} size={30} lineHeight={36} font={FONT_MONO}>{digit}</Label></div>)}</div>
}

const DEVICES_POLL_MS = 5000
function DeviceAccess({ close }: { close: () => void }) {
  const t = useTheme()
  const [client] = useState(() => getClient()!)
  const [exposure, setExposure] = useState<Exposure | null>(null)
  const [devices, setDevices] = useState<TokenInfo[]>([])
  const [invitation, setInvitation] = useState<PairingCreateResult | null>(null)
  const [address, setAddress] = useState('')
  const [expired, setExpired] = useState(false)
  const [busy, setBusy] = useState(false)
  const [exposureBusy, setExposureBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    void client.call('access.exposure.get', {}).then((value) => { if (live) setExposure(value) }, () => { /* Older daemons have no exposure control; the row stays hidden. */ })
    return () => { live = false }
  }, [client])
  // The paired-device list follows the other machines: refreshed every 5 s while this dialog is open, like the desktop.
  useEffect(() => {
    let live = true, loading = false
    const refresh = () => {
      if (loading || client.status !== 'open') return
      loading = true
      void client.call('access.tokens.list', {}).then((value) => { if (live) setDevices(value.tokens) }, (e) => { if (live) setError(errorText(e)) }).finally(() => { loading = false })
    }
    refresh()
    const timer = setInterval(refresh, DEVICES_POLL_MS)
    return () => { live = false; clearInterval(timer) }
  }, [client])
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
    setAddress(suggestedAddress(next.endpoints, nextExposure, activeEnvironment().local ? null : client.endpoint.url))
  }
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); try { await action() } catch (e) { setError(errorText(e)) } finally { setBusy(false) } }
  const paired = devices.filter(d => d.label !== 'bootstrap')
  const card = { display: 'flex', borderRadius: 14, backgroundColor: t.variant === 'dark' ? ink(t, .016) : ink(t, .03) }
  return <>
    <DialogHeader title="Pair a device" description={`Give another device access to ${activeEnvironment().name}.`} onClose={close} />
    <DialogBody testId="environment-access-body" scroll>
      {exposure && <div style={{ ...card, alignItems: 'center', gap: 16, paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: 12 }}><div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexGrow: 1, minWidth: 0 }}><Label color={t.text} size={14} lineHeight={21} weight={500}>Reachable over Tailscale</Label><Hint>{exposure.tailscale_ip ? exposure.tailscale ? `Devices on your tailnet connect to ${exposure.tailscale_ip} directly.` : 'Lets phones and other devices on your tailnet pair without a tunnel.' : 'Tailscale is not running on this machine.'}</Hint></div><Switch testId="environment-tailscale" label="Reachable over Tailscale" checked={exposure.tailscale} disabled={exposureBusy || (!exposure.tailscale && !exposure.tailscale_ip)} onChange={tailscale => { setExposureBusy(true); setError(''); void (async () => { try { const value = await client.call('access.exposure.set', { tailscale }); setExposure(value); if (invitation) await create(value) } catch (e) { setError(errorText(e)) } finally { setExposureBusy(false) } })() }} /></div>}
      {invitation && <>
        {qr && <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}><div role="img" aria-label="Pairing QR code" style={{ width: 176, height: 176, padding: 12, borderRadius: 14, backgroundColor: '#ffffff' }}><svg testId="pairing-qr" source={qr} style={{ width: 152, height: 152, color: '#000000' }} /></div><Hint center>Scan with the Kybern mobile app, or copy the invitation below.</Hint></div>}
        <div style={{ ...card, flexDirection: 'column', alignItems: 'center', gap: 8, padding: 16 }}><CodeDigits code={invitation.code} /><Hint>{expired ? 'Code expired. Create a new invitation.' : `Use once before ${new Date(invitation.expires_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}</Hint></div>
        <Field label="Connection address"><EnvInput testId="pairing-address" label="Connection address" value={address} onChange={setAddress} placeholder="https://machine.example.ts.net" /></Field>
        {!address && <Hint>Enter an address the other device can reach, such as your Tailscale HTTPS address or SSH tunnel address.</Hint>}
        {!!address && isLoopbackAddress(address) && <Hint>{`This address only works on the machine itself.${exposure?.tailscale_ip && !exposure.tailscale ? ' Turn on Reachable over Tailscale to get one other devices can use.' : ' Enter an address the other device can reach.'}`}</Hint>}
        <EnvButton block icon="copy" testId="pairing-copy" disabled={!link || expired} onClick={() => { if (link) { copyText(link); toast('Copied pairing invitation') } }}>Copy invitation</EnvButton>
      </>}
      <EnvButton block variant={invitation && !expired ? 'secondary' : 'primary'} testId="pairing-create" busy={busy} onClick={() => void run(() => create())}>{invitation ? 'Create new invitation' : 'Create pairing invitation'}</EnvButton>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 16 }}><Label color={t.text} size={14} lineHeight={21} weight={500}>Paired devices</Label>
        {!paired.length && <div style={{ paddingTop: 8, paddingBottom: 8 }}><Hint>Create an invitation, then open it on the device you want to connect.</Hint></div>}
        {paired.map(device => <div key={device.id} style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 8, paddingBottom: 8 }}><Label color={t.text} size={13} lineHeight={21.125} style={{ flexGrow: 1, minWidth: 0 }}>{device.label}</Label>{device.revoked ? <Label color={t.textSecondary} size={12} lineHeight={16}>Revoked</Label> : <EnvButton variant="ghost" size="xs" testId={`revoke-${device.id}`} onClick={() => void run(async () => { await client.call('access.tokens.revoke', { token_id: device.id }); setDevices(list => list.map(d => d.id === device.id ? { ...d, revoked: true } : d)) })}>Revoke access</EnvButton>}</div>)}
      </div>
      {!!error && <ErrorText testId="environment-access-error">{error}</ErrorText>}
    </DialogBody>
  </>
}
