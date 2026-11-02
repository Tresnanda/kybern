// Cursor runs on its own SDK, which Kybern pins per release and installs on request. The SDK's state lives in the
// Cursor row of "Installed agents" (install or update it there); the account section appears once the SDK is in place.
import { useEffect, useRef, useState } from 'react'
import type { CursorSetupAction, CursorSetupStatus } from '../../../../packages/kybern-client/src/types.ts'
import { getClient } from '../state.ts'
import { loadProviders } from '../nav/live.ts'
import { openUrl } from '../pulls/PrStates.tsx'
import { Row, Section } from './controls.tsx'
import { Button } from '../kit/Button.tsx'

export type CursorSetup = ReturnType<typeof useCursorSetup>

/** One reader for the page: polls while an install or a sign-in runs, and opens the sign-in page once. */
export function useCursorSetup() {
  const [status, setStatus] = useState<CursorSetupStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const opened = useRef('')
  const client = getClient()
  const apply = (next: CursorSetupStatus) => {
    setStatus(next)
    if (next.signing_in && next.login_url && opened.current !== next.login_url) { opened.current = next.login_url; openUrl(next.login_url) }
  }
  const waiting = !!(status?.installing || status?.signing_in)
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await client!.call('cursor.status', {})
        if (!live) return
        apply(next)
        if (next.installing || next.signing_in) timer = setTimeout(() => void poll(), 1500)
        else if (waiting) void loadProviders(true)
      } catch (e) { if (live) setError(String(e)) }
    }
    void poll()
    return () => { live = false; clearTimeout(timer) }
  }, [client, waiting])
  const act = async (action: CursorSetupAction) => {
    setBusy(true); setError('')
    try {
      const next = await client!.call('cursor.setup', { action })
      if (client !== getClient()) return
      apply(next)
      if (!next.installing && !next.signing_in) await loadProviders(true)
    } catch (e) { setError(`Unable to complete Cursor setup. ${String(e)}`) } finally { setBusy(false) }
  }
  const check = async () => {
    setBusy(true); setError('')
    try { apply(await client!.call('cursor.status', {})); await loadProviders(true) } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  return { status, busy, error: error || status?.error || '', act, check }
}

/** The Cursor row's action while the SDK is missing or out of date. */
export function CursorSdkAction({ setup }: { setup: CursorSetup }) {
  const { status, busy, act } = setup
  if (!status) return <Button busy>Checking…</Button>
  if (status.installed) return null
  if (status.installing) return <Button busy>Installing…</Button>
  return <Button testId="cursor-install" variant="primary" disabled={busy || !!status.problem} onClick={() => void act('install')}>{status.previous_version ? 'Update SDK' : 'Install SDK'}</Button>
}

/** Sign-in for the SDK, shown once it is installed. */
export function CursorAccountSection({ setup }: { setup: CursorSetup }) {
  const { status, busy, error, act, check } = setup
  if (!status?.installed) return null
  const description = error
    || (status.signing_in ? 'Finish signing in in your browser. This page updates when you’re done.'
      : status.email ? `Signed in as ${status.email}`
      : status.account === 'api_key' ? 'Signed in with CURSOR_API_KEY.'
      : 'Sign in with your Cursor account to run Cursor here.')
  return (
    <Section title="Cursor account">
      <Row title="Account" description={description}>
        {status.signing_in
          ? <><Button variant="primary" disabled={!status.login_url} onClick={() => status.login_url && openUrl(status.login_url)}>Open sign-in page</Button><Button testId="cursor-cancel" variant="ghost" disabled={busy} onClick={() => void act('cancel_sign_in')}>Cancel</Button></>
          : status.account === 'signed_in' ? <Button testId="cursor-sign-out" disabled={busy} onClick={() => void act('sign_out')}>Sign out</Button>
          : status.account !== 'api_key' ? <Button testId="cursor-sign-in" variant="primary" disabled={busy} onClick={() => void act('sign_in')}>Sign in</Button>
          : null}
        <Button testId="cursor-check" variant="ghost" disabled={busy} onClick={() => void check()}>Check again</Button>
      </Row>
    </Section>
  )
}
