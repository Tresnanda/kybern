// One sign-in attempt for the Add account sheet (`components/kybern/accounts/useAccountLogin.ts`):
// starts it, follows it (the daemon's change notification, plus a poll every second while it is
// live, whichever arrives first), opens the browser, takes a pasted code and cancels or finishes it.
// A sign-in the machine no longer knows, or a machine that stops answering, is reported as lost: the
// sheet never waits forever.
import { useCallback, useEffect, useRef, useState } from 'react'
import { isBusyRefusal, RpcCallError, type KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { acceptLoginUpdate } from '../shared/lib/accounts.ts'
import { ACCOUNTS_LOGIN_CHANGED_NOTIFICATION, type AccountLogin, type AccountLoginStartParams, type ProviderInstance, type TerminalInfo } from '../../../../packages/kybern-client/src/types.ts'
import { describe } from '../problems/describe.ts'
import { openExternal } from '../settings/external.ts'
import { getClient } from '../state.ts'
import { refreshAccounts } from '../usage/accounts.ts'

const POLL_MS = 1000
/** How long a machine may go without answering before the sheet says the connection is lost. */
const LOST_AFTER_MS = 10_000

/** The daemon answered with an error, so the call reached it: not a dropped or busy connection. */
const answered = (error: unknown) => error instanceof RpcCallError && !isBusyRefusal(error)
const isLive = (login: AccountLogin) => login.phase === 'starting' || login.phase === 'waiting' || login.phase === 'verifying'

/** Why a running sign-in can't be followed any more. */
export type LostLogin =
  /** The machine no longer knows it: it restarted, updated or stopped waiting. */
  | 'ended'
  /** The machine stopped answering. */
  | 'offline'

export interface AccountLoginApi {
  login: AccountLogin | null
  /** The terminal of an older daemon's sign-in, which has no login record. */
  legacyTerminal: TerminalInfo | null
  /** A start or finish that did not reach the daemon, or the daemon's own failure. */
  failure: string | null
  starting: boolean
  /** A running sign-in that can't be followed any more; `retry` picks it up if it is still there, else starts again. */
  lost: LostLogin | null
  /** A pasted code was sent and the daemon has not answered yet, answered that it was wrong, or never got it. */
  codeState: 'idle' | 'sending' | 'wrong' | 'unsent'
  /** How many codes the daemon refused; remount the paste field on each. */
  wrongCodes: number
  start: (params: AccountLoginStartParams) => Promise<void>
  retry: () => Promise<void>
  /** Cancel the current attempt and start another with changed parameters. */
  restart: (patch: Partial<AccountLoginStartParams>) => Promise<void>
  submitCode: (code: string) => Promise<void>
  cancel: () => Promise<void>
  signInLegacy: (provider: ProviderInstance) => Promise<void>
}

/** `machine`: the client of the machine to sign in (`accounts/store.ts` `clientOf`); the window's own machine without it.
 *  `openPage: false` keeps a browser sign-in's page closed (an "Authorize only" handoff opens the page it is given).
 *  `pollMs` and `lostAfterMs` are for tests. */
export function useAccountLogin(machine?: KybernClient | null, { openPage = true, pollMs = POLL_MS, lostAfterMs = LOST_AFTER_MS }: { openPage?: boolean; pollMs?: number; lostAfterMs?: number } = {}): AccountLoginApi {
  const [client] = useState(() => (machine !== undefined ? machine : getClient()))
  const opens = useRef(openPage)
  opens.current = openPage
  const [login, setLogin] = useState<AccountLogin | null>(null)
  const [legacyTerminal, setLegacyTerminal] = useState<TerminalInfo | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [codeState, setCodeState] = useState<AccountLoginApi['codeState']>('idle')
  const [wrongCodes, setWrongCodes] = useState(0)
  const [lostLogin, setLostLogin] = useState<{ id: string; why: LostLogin } | null>(null)
  const loginRef = useRef<AccountLogin | null>(null)
  const paramsRef = useRef<AccountLoginStartParams | null>(null)
  const openedRef = useRef<string | null>(null)
  /** A code is on its way (`sent`), or the connection dropped while sending it (`unsure`: it may have arrived). */
  const submittedRef = useRef<false | 'sent' | 'unsure'>(false)
  const closedRef = useRef(false)
  const startRef = useRef<(params: AccountLoginStartParams) => Promise<void>>(async () => {})

  const adopt = useCallback((next: AccountLogin) => {
    const kept = acceptLoginUpdate(loginRef.current, next)
    if (kept !== next) return
    loginRef.current = next
    setLogin(next)
    // The browser has to open on this machine, so the client opens the page, not the daemon.
    if (opens.current && next.mode === 'browser' && next.url && next.phase !== 'failed' && openedRef.current !== next.id) {
      openedRef.current = next.id
      void openExternal(next.url).catch(() => { /* "Open browser again" is on screen */ })
    }
    // The machine has the code after all.
    if (next.phase === 'verifying' || next.phase === 'signed_in') setCodeState((state) => (state === 'unsent' ? 'idle' : state))
    if (next.mode === 'paste' && submittedRef.current) {
      if (next.phase === 'signed_in') submittedRef.current = false
      // A code is single use. A wrong one restarts the attempt in the same mode. A sign-in that failed after a code
      // that may never have arrived says nothing about the code.
      else if ((next.phase === 'failed' && submittedRef.current === 'sent') || (next.error && next.phase !== 'verifying' && next.phase !== 'failed')) {
        submittedRef.current = false
        setCodeState('wrong')
        setWrongCodes((count) => count + 1)
        if (next.phase === 'failed' && paramsRef.current) void startRef.current(paramsRef.current)
      }
    }
  }, [])

  const start = useCallback(async (params: AccountLoginStartParams) => {
    if (!client) return
    paramsRef.current = params
    setStarting(true)
    setFailure(null)
    setCodeState((state) => (state === 'wrong' ? state : 'idle'))
    try {
      const next = await client.call('providers.accounts.login.start', params)
      if (closedRef.current) {
        void client.call('providers.accounts.login.cancel', { id: next.id }).catch(() => {})
        return
      }
      adopt(next)
      // The machine may answer with the sign-in it still had.
      setLostLogin(null)
    } catch (error) {
      if (!closedRef.current) setFailure(describe(error, { action: 'sign in' }).body)
    } finally {
      setStarting(false)
    }
  }, [adopt, client])
  useEffect(() => { startRef.current = start })

  // Follow the attempt: a poll every second and the change notification. Nothing runs once it settles or is lost.
  const id = login?.id
  const lost = login && lostLogin?.id === login.id ? lostLogin.why : null
  const live = !!login && isLive(login) && !lost
  useEffect(() => {
    if (!id || !live || !client) return
    const off = client.onNotification(ACCOUNTS_LOGIN_CHANGED_NOTIFICATION, (params) => {
      const next = params as AccountLogin
      if (next.id === id) adopt(next)
    })
    let stopped = false
    let askedAt: number | null = null
    let silentSince: number | null = null
    const lose = (why: LostLogin) => { if (!stopped) setLostLogin({ id, why }) }
    const timer = setInterval(() => {
      // One question at a time; one that hangs counts as silence.
      if (askedAt !== null) { if (Date.now() - askedAt >= lostAfterMs) lose('offline'); return }
      askedAt = Date.now()
      void client.call('providers.accounts.login.get', { id }).then(
        (next) => { askedAt = null; silentSince = null; if (!stopped) adopt(next) },
        (error: unknown) => {
          const asked = askedAt ?? Date.now()
          askedAt = null
          if (answered(error)) return lose('ended')
          silentSince ??= asked
          if (Date.now() - silentSince >= lostAfterMs) lose('offline')
        },
      )
    }, pollMs)
    return () => { stopped = true; off(); clearInterval(timer) }
  }, [id, live, adopt, client, pollMs, lostAfterMs])

  const cancel = useCallback(async () => {
    if (!client) return
    closedRef.current = true
    const current = loginRef.current
    if (legacyTerminal) await client.call('terminals.close', { terminal_id: legacyTerminal.id }).catch(() => {})
    if (current && current.phase !== 'canceled' && !(current.phase === 'signed_in' && current.instance)) await client.call('providers.accounts.login.cancel', { id: current.id }).catch(() => {})
  }, [legacyTerminal, client])

  const restart = useCallback(async (patch: Partial<AccountLoginStartParams>) => {
    const previous = paramsRef.current
    const current = loginRef.current
    if (!previous || !client) return
    if (current) await client.call('providers.accounts.login.cancel', { id: current.id }).catch(() => {})
    submittedRef.current = false
    setCodeState('idle')
    await start({ ...previous, ...patch })
  }, [start, client])

  const retry = useCallback(async () => {
    const current = loginRef.current
    if (lost && current && client) {
      // The connection may be back with the sign-in still running, or finished: pick it up instead of cancelling it.
      const still = await client.call('providers.accounts.login.get', { id: current.id }).catch(() => null)
      if (still && (isLive(still) || still.phase === 'signed_in')) {
        setLostLogin(null)
        adopt(still)
        return
      }
    }
    if (paramsRef.current) await restart({})
  }, [restart, lost, adopt, client])

  const submitCode = useCallback(async (code: string) => {
    const current = loginRef.current
    if (!current || !client) return
    submittedRef.current = 'sent'
    setCodeState('sending')
    try {
      adopt(await client.call('providers.accounts.login.input', { id: current.id, code: code.trim() }))
      setCodeState((state) => (state === 'sending' ? 'idle' : state))
    } catch (error) {
      // Only the sign-in itself says a code is wrong. A call that failed says nothing about the code: keep it.
      if (!answered(error)) {
        submittedRef.current = 'unsure'
        setCodeState('unsent')
        return
      }
      submittedRef.current = false
      setCodeState('unsent')
      // The machine refused the call: see whether the sign-in is still there.
      try {
        adopt(await client.call('providers.accounts.login.get', { id: current.id }))
      } catch (gone) {
        if (answered(gone)) { setCodeState('idle'); setLostLogin({ id: current.id, why: 'ended' }) }
      }
    }
  }, [adopt, client])

  const signInLegacy = useCallback(async (provider: ProviderInstance) => {
    if (!client) return
    setStarting(true)
    setFailure(null)
    try {
      setLegacyTerminal(await client.call('providers.accounts.sign_in', provider))
    } catch (error) {
      setFailure(describe(error, { action: 'sign in' }).body)
    } finally {
      setStarting(false)
    }
  }, [client])

  // Look at what the daemon has once, in case the list changed behind the sheet.
  useEffect(() => { if (login?.phase === 'signed_in') void refreshAccounts() }, [login?.phase])

  return { login, legacyTerminal, failure, starting, lost, codeState, wrongCodes, start, retry, restart, submitCode, cancel, signInLegacy }
}
