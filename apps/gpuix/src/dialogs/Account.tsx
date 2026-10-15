import { execFile } from 'node:child_process'
import { useEffect, useRef, useState } from 'react'
import type { AccountLogin, AccountLoginMode, ProviderKind } from '../../../../packages/kybern-client/src/types.ts'
import { acceptLoginUpdate, initialLoginMode, supportsDeviceCode, supportsPasteCode } from '@/lib/accounts'
import { Dialog, DialogHeader } from '../nav/overlay.tsx'
import { Button, Select, Switch, TextField } from '../settings/controls.tsx'
import { activeEnvironment } from '../shell/environment.ts'
import { getClient } from '../state.ts'
import { useNav } from '../nav/store.ts'
import { errorText } from '../nav/actions.ts'
import { copyText } from '../transcript/store.ts'
import { Label, useTheme } from '../ui.tsx'

/** One daemon-owned login attempt. Notifications drive progress; Refresh is a
 * recovery path, so a waiting sheet has no polling clock. */
export function Account({ close, provider }: { close: () => void; provider?: ProviderKind }) {
  const t = useTheme()
  const providers = useNav((s) => s.providers)
  const [client] = useState(() => getClient()!)
  const [kind, setKind] = useState<ProviderKind>(provider ?? 'claude-code')
  const [login, setLogin] = useState<AccountLogin | null>(null)
  const current = useRef<AccountLogin | null>(null)
  const mounted = useRef(true)
  const finished = useRef(false)
  const [name, setName] = useState('')
  const [makeDefault, setMakeDefault] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const adopt = (next: AccountLogin) => {
    if (!mounted.current) return
    current.current = acceptLoginUpdate(current.current, next)
    setLogin(current.current)
    if (next.phase === 'signed_in') setName((value) => value || next.suggested_name || next.identity?.email || 'New account')
  }
  useEffect(() => {
    const stop = client.onNotification('providers.accounts.login.changed', (value) => { const next = value as AccountLogin; if (next.id === current.current?.id) adopt(next) })
    return () => {
      mounted.current = false; stop()
      const pending = current.current
      if (pending && !finished.current && !pending.instance) void client.call('providers.accounts.login.cancel', { id: pending.id }).catch(() => {})
    }
  }, [client])
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); try { await action() } catch (e) { if (mounted.current) setError(errorText(e)) } finally { if (mounted.current) setBusy(false) } }
  const begin = (mode: AccountLoginMode) => void run(async () => {
    if (current.current) await client.call('providers.accounts.login.cancel', { id: current.current.id })
    current.current = null; setLogin(null)
    const next = await client.call('providers.accounts.login.start', { kind, mode })
    if (!mounted.current) { await client.call('providers.accounts.login.cancel', { id: next.id }); return }
    adopt(next)
  })
  const mode = initialLoginMode(kind, !activeEnvironment().local)
  const live = login && !['failed', 'canceled', 'signed_in'].includes(login.phase)
  const finish = async () => {
    if (!login || login.phase !== 'signed_in' || login.duplicate_of) return
    await client.call('providers.accounts.login.finish', { id: login.id, name: name.trim() || login.suggested_name || 'New account', color: login.suggested_color, make_default: makeDefault })
    finished.current = true; close()
  }
  const dismiss = () => { if (busy) return; if (login?.phase === 'signed_in' && !login.duplicate_of && !login.instance) void run(finish); else close() }
  return <Dialog onClose={dismiss} width={512} testId="add-account"><DialogHeader title={login?.phase === 'signed_in' ? 'Account connected' : 'Add account'} description={`Sign in on ${activeEnvironment().name}.`} onClose={dismiss} />
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 20 }}>
      {!login && <><Label color={t.text} size={12}>Agent</Label><Select testId="account-provider" label="Agent" value={kind} disabled={busy} options={providers.map((p) => ({ value: p.kind, label: p.display_name, disabled: !p.available }))} onChange={(value) => setKind(value as ProviderKind)} />
        {mode === 'terminal' ? <Label color={t.textSecondary} size={13} lineHeight={18}>This agent signs in through an interactive terminal. Use Kybern desktop’s Add account sheet to finish terminal sign-in.</Label> : <Button testId="account-start" disabled={busy} onClick={() => begin(mode)}>{busy ? 'Starting…' : 'Continue to sign in'}</Button>}
      </>}
      {login && <>
        {login.error && <Label color={t.red} size={13} lineHeight={18}>{login.error}</Label>}
        {live && <>
          <Label color={t.text} size={13}>{login.phase === 'verifying' ? 'Checking your account…' : login.mode === 'device_code' ? 'Enter this code on the sign-in page.' : login.mode === 'paste' ? 'Sign in, then copy the authorization code.' : 'Finish signing in in your browser.'}</Label>
          {login.user_code && <><Label color={t.text} size={28}>{login.user_code}</Label><Button onClick={() => copyText(login.user_code!)}>Copy code</Button></>}
          {login.url && <Button testId="account-browser" onClick={() => { try { const url = new URL(login.url!); if (url.protocol !== 'https:' && url.protocol !== 'http:') throw Error('Unsupported sign-in address'); execFile('open', [url.toString()], (e) => { if (e) setError('Unable to open the sign-in page. Copy its address and open it in your browser.') }) } catch (e) { setError(errorText(e)) } }}>Open sign-in page</Button>}
          {login.url && <Button onClick={() => copyText(login.url!)}>Copy sign-in address</Button>}
          {login.mode === 'paste' && <Button testId="account-paste" disabled={busy} onClick={() => execFile('pbpaste', (e, code) => { if (e || !code.trim()) { setError('Copy the authorization code, then try again.'); return } void run(async () => adopt(await client.call('providers.accounts.login.input', { id: login.id, code: code.trim() }))) })}>Paste authorization code</Button>}
          <Button disabled={busy} onClick={() => void run(async () => adopt(await client.call('providers.accounts.login.get', { id: login.id })))}>Check sign-in</Button>
          {login.mode === 'browser' && supportsPasteCode(kind) && <Button disabled={busy} onClick={() => begin('paste')}>Use an authorization code</Button>}
          {login.mode === 'browser' && supportsDeviceCode(kind) && <Button disabled={busy} onClick={() => begin('device_code')}>Use a device code</Button>}
        </>}
        {login.phase === 'signed_in' && (login.duplicate_of ? <><Label color={t.text} size={13}>This account is already connected.</Label><Button onClick={dismiss}>Done</Button></> : <>
          <Label color={t.textSecondary} size={13}>{login.identity?.email ?? 'Signed in successfully'}</Label>
          <TextField testId="account-name" label="Account name" value={name} onChange={setName} placeholder="Account name" width="100%" />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><Switch label="Use by default" checked={makeDefault} onChange={setMakeDefault} /><Label color={t.text} size={13}>Use by default</Label></div>
          <Button testId="account-finish" disabled={busy || !name.trim()} onClick={() => void run(finish)}>{busy ? 'Adding account…' : 'Add account'}</Button>
        </>)}
        {(login.phase === 'failed' || login.phase === 'canceled') && <Button disabled={busy} onClick={() => begin(mode)}>Try again</Button>}
      </>}
      {error && <Label color={t.red} size={12} lineHeight={18}>{error}</Label>}
    </div>
  </Dialog>
}
