import { execFile } from 'node:child_process'
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useWindowSize } from '@gpuix/react'
import { parsePairingInvitation, pairingInvitation } from '../../../../packages/kybern-client/src/address.ts'
import type { Exposure, PairingCreateResult, TokenInfo } from '../../../../packages/kybern-client/src/types.ts'
import { Dialog, DialogHeader } from '../nav/overlay.tsx'
import { Button, Switch, TextField } from '../settings/controls.tsx'
import { activeEnvironment, onEnvironmentChange } from '../shell/environment.ts'
import { getClient } from '../state.ts'
import { Label, useTheme } from '../ui.tsx'
import { copyText, errorText } from '../transcript/store.ts'
import { toast } from '../shell/toasts.tsx'
import { connectEnvironment, forgetEnvironment, saveEnvironment } from './actions.ts'
import { localProfile, readRegistry, type EnvironmentProfile } from './registry.ts'
import { pairingQrSvg } from './qr.ts'

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

function Field({ label, children }: { label: string; children: ReactNode }) {
  const t = useTheme()
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><Label color={t.text} size={12} weight={500}>{label}</Label>{children}</div>
}
function EnvironmentForm({ profile, close }: { profile?: EnvironmentProfile; close: () => void }) {
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
      close(); connectEnvironment(saved.id)
    } catch (e) { setError(errorText(e)); setBusy(false) }
  }
  const invited = parsePairingInvitation(address)
  return <>
    <DialogHeader title={profile ? 'Edit environment' : 'Add environment'} description="Switch between machines. Each keeps its own projects and threads." onClose={close} />
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 20 }}>
      <Field label="Name"><TextField testId="environment-name" autoFocus label="Name" value={name} onChange={setName} width="100%" readOnly={busy} placeholder="Dev server" /></Field>
      <Field label="Address or pairing invitation"><TextField testId="environment-address" label="Address or pairing invitation" value={address} onChange={(value) => { setAddress(value); if (parsePairingInvitation(value)) setToken('') }} width="100%" readOnly={busy} placeholder="https://machine.example.ts.net" /></Field>
      <Field label={`Pairing code${profile ? ' (optional)' : ''}`}><TextField testId="environment-code" label="Pairing code" value={invited?.code ?? code} onChange={(value) => { setCode(value.replace(/\D/g, '').slice(0, 6)); setToken('') }} width="100%" readOnly={busy || !!invited} placeholder="000000" /></Field>
      <Label color={t.textSecondary} size={13} lineHeight={18}>{profile ? 'Leave the code empty to keep this device’s access.' : 'On the other machine, choose Pair a device in the environment menu. For a server or VPS, run kybern pair over SSH.'}</Label>
      <Button testId="environment-token-toggle" onClick={() => setAdvanced(!advanced)}>Use an existing device token</Button>
      {advanced && <Field label="Device token"><Button testId="environment-token" disabled={busy} onClick={() => execFile('pbpaste', (e, text) => { if (e) setError('Unable to read the clipboard. Copy the device token and try again.'); else { setToken(text.trim()); setCode('') } })}>{token ? 'Device token pasted · Replace from clipboard' : 'Paste device token from clipboard'}</Button></Field>}
      <Label color={t.textSecondary} size={12} lineHeight={17}>For automatic SSH installation and tunnels, add the machine in Kybern desktop. Here, use an address reachable from this Mac.</Label>
      {error && <Label color={t.red} size={12} lineHeight={18}>{error}</Label>}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}><Button testId="environment-save" disabled={busy || !name.trim() || !address.trim() || (!profile && !invited && code.length !== 6 && !token.trim())} onClick={() => void submit()}>{busy ? 'Connecting' : 'Save and connect'}</Button></div>
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
    <virtual-list testId="environment-manage-list" style={{ width: '100%', height: Math.min(360, profiles.length * 72) }}>
      {profiles.map((profile) => <div key={profile.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 16 }}><div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexGrow: 1, minWidth: 0 }}><Label color={t.text} size={14} truncate>{profile.name}</Label><Label color={t.textSecondary} size={12} truncate>{profile.ssh ? `ssh ${profile.ssh.target}` : profile.url ?? profile.hostname ?? 'Managed by Kybern'}</Label></div>{profile.id !== 'local' && <><Button testId={`environment-edit-${profile.id}`} onClick={() => showEnvironmentDialog({ kind: 'add', profile })}>Edit</Button><Button testId={`environment-forget-${profile.id}`} onClick={() => { try { forgetEnvironment(profile.id); setRevision((n) => n + 1) } catch (e) { setError(errorText(e)) } }}>Forget</Button></>}</div>)}
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
    <virtual-list testId="environment-access-body" style={{ width: '100%', height: Math.min(size.height - 130, invitation ? 620 : 340) }}>
      {exposure && <div key="tailscale" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 16 }}><div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexGrow: 1 }}><Label color={t.text} size={13}>Reachable over Tailscale</Label><Label color={t.textSecondary} size={12} lineHeight={17}>{exposure.tailscale_ip ? exposure.tailscale ? `Devices on your tailnet connect to ${exposure.tailscale_ip} directly.` : 'Lets phones and other devices on your tailnet pair without a tunnel.' : 'Tailscale is not running on this machine.'}</Label></div><Switch testId="environment-tailscale" label="Reachable over Tailscale" checked={exposure.tailscale} disabled={busy || (!exposure.tailscale && !exposure.tailscale_ip)} onChange={(tailscale) => void run(async () => { const value = await client.call('access.exposure.set', { tailscale }); setExposure(value); if (invitation) await create(value) })} /></div>}
      {invitation && <div key="invitation" style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16 }}>
        {qr && <div style={{ display: 'flex', justifyContent: 'center' }}><div style={{ width: 176, height: 176, backgroundColor: '#ffffff' }}><svg testId="pairing-qr" source={qr} style={{ width: 176, height: 176, color: '#000000' }} /></div></div>}
        <Label color={t.text} size={30} style={{ textAlign: 'center' }}>{invitation.code}</Label>
        <Label color={t.textSecondary} size={12} style={{ textAlign: 'center' }}>{expired ? 'Code expired. Create a new invitation.' : `Use once before ${new Date(invitation.expires_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}</Label>
        <Field label="Connection address"><TextField testId="pairing-address" label="Connection address" value={address} onChange={setAddress} width="100%" placeholder="https://machine.example.ts.net" /></Field>
        {(!address || isLoopbackAddress(address)) && <Label color={t.textSecondary} size={12} lineHeight={17}>{address ? 'This address only works on the machine itself. Enter an address the other device can reach.' : 'Enter an address the other device can reach, such as your Tailscale HTTPS address or SSH tunnel address.'}</Label>}
        <Button testId="pairing-copy" disabled={!link || expired} onClick={() => { if (link) { copyText(link); toast('Copied pairing invitation') } }}>Copy invitation</Button>
      </div>}
      <div key="create" style={{ display: 'flex', paddingLeft: 16, paddingRight: 16, paddingBottom: 16 }}><Button testId="pairing-create" disabled={busy} onClick={() => void run(() => create())}>{invitation ? 'Create new invitation' : 'Create pairing invitation'}</Button></div>
      <div key="heading" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 16 }}><Label color={t.text} size={14} weight={500}>Paired devices</Label><Button testId="pairing-refresh" onClick={() => setReload((n) => n + 1)}>Refresh</Button></div>
      {!devices.filter((d) => d.label !== 'bootstrap').length && <div key="empty" style={{ padding: 16 }}><Label color={t.textSecondary} size={12}>Create an invitation, then open it on the device you want to connect.</Label></div>}
      {devices.filter((d) => d.label !== 'bootstrap').map((device) => <div key={device.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 16 }}><Label color={t.text} size={13} truncate style={{ flexGrow: 1 }}>{device.label}</Label>{device.revoked ? <Label color={t.textSecondary} size={12}>Revoked</Label> : <Button testId={`revoke-${device.id}`} disabled={busy} onClick={() => void run(async () => { await client.call('access.tokens.revoke', { token_id: device.id }); setDevices((list) => list.map((d) => d.id === device.id ? { ...d, revoked: true } : d)) })}>Revoke access</Button>}</div>)}
      {error && <div key="error" style={{ padding: 16 }}><Label color={t.red} size={12} lineHeight={18}>{error}</Label></div>}
    </virtual-list>
  </>
}
