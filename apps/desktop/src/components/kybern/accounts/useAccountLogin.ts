// One sign-in attempt for the Add account sheet: starts it, follows it (a poll
// every second plus the daemon's change notification, whichever arrives first),
// opens the browser, takes a pasted code and cancels or finishes it.

import { useCallback, useEffect, useRef, useState } from "react"

import { acceptLoginUpdate } from "@/lib/accounts"
import { openExternal } from "@/lib/tauri"
import { ACCOUNTS_LOGIN_CHANGED_NOTIFICATION, type AccountLogin, type AccountLoginStartParams, type ProviderInstance, type TerminalInfo } from "@/protocol"
import { refreshAccounts } from "@/state/accounts"
import { activeRuntime, errorText, rpc } from "@/state/rpc"

const POLL_MS = 1000

export interface AccountLoginApi {
  login: AccountLogin | null
  /** The terminal of an older daemon's sign-in, which has no login record. */
  legacyTerminal: TerminalInfo | null
  /** A start or finish that did not reach the daemon, or the daemon's own failure. */
  failure: string | null
  starting: boolean
  /** A pasted code was sent and the daemon has not answered yet, or answered with a wrong code. */
  codeState: "idle" | "sending" | "wrong"
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

export function useAccountLogin(): AccountLoginApi {
  const [login, setLogin] = useState<AccountLogin | null>(null)
  const [legacyTerminal, setLegacyTerminal] = useState<TerminalInfo | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [codeState, setCodeState] = useState<AccountLoginApi["codeState"]>("idle")
  const [wrongCodes, setWrongCodes] = useState(0)
  const loginRef = useRef<AccountLogin | null>(null)
  const paramsRef = useRef<AccountLoginStartParams | null>(null)
  const openedRef = useRef<string | null>(null)
  const submittedRef = useRef(false)
  const closedRef = useRef(false)
  const startRef = useRef<(params: AccountLoginStartParams) => Promise<void>>(async () => {})

  const adopt = useCallback((next: AccountLogin) => {
    const kept = acceptLoginUpdate(loginRef.current, next)
    if (kept !== next) return
    loginRef.current = next
    setLogin(next)
    // The browser has to open on this machine, so the client opens the page, not the daemon.
    if (next.mode === "browser" && next.url && next.phase !== "failed" && openedRef.current !== next.id) {
      openedRef.current = next.id
      void openExternal(next.url).catch(() => { /* "Open browser again" is on screen */ })
    }
    if (next.mode === "paste" && submittedRef.current) {
      if (next.phase === "signed_in") submittedRef.current = false
      // A code is single use. A wrong one restarts the attempt in the same mode.
      else if (next.phase === "failed" || (next.error && next.phase !== "verifying")) {
        submittedRef.current = false
        setCodeState("wrong")
        setWrongCodes((count) => count + 1)
        if (next.phase === "failed" && paramsRef.current) void startRef.current(paramsRef.current)
      }
    }
  }, [])

  const start = useCallback(async (params: AccountLoginStartParams) => {
    paramsRef.current = params
    setStarting(true)
    setFailure(null)
    setCodeState((state) => (state === "wrong" ? state : "idle"))
    try {
      const next = await rpc().call("providers.accounts.login.start", params)
      if (closedRef.current) {
        void rpc().call("providers.accounts.login.cancel", { id: next.id }).catch(() => {})
        return
      }
      adopt(next)
    } catch (error) {
      if (!closedRef.current) setFailure(errorText(error))
    } finally {
      setStarting(false)
    }
  }, [adopt])
  useEffect(() => { startRef.current = start })

  // Follow the attempt: a poll every second and the change notification.
  const id = login?.id
  const live = !!login && (login.phase === "starting" || login.phase === "waiting" || login.phase === "verifying")
  useEffect(() => {
    if (!id || !live) return
    let off = () => {}
    try {
      off = activeRuntime().rpc().onNotification(ACCOUNTS_LOGIN_CHANGED_NOTIFICATION, (params) => {
        const next = params as AccountLogin
        if (next.id === id) adopt(next)
      })
    } catch { /* the poll below carries on */ }
    const timer = setInterval(() => {
      void rpc().call("providers.accounts.login.get", { id }).then(adopt, () => {})
    }, POLL_MS)
    return () => {
      off()
      clearInterval(timer)
    }
  }, [id, live, adopt])

  const cancel = useCallback(async () => {
    closedRef.current = true
    const current = loginRef.current
    if (legacyTerminal) await rpc().call("terminals.close", { terminal_id: legacyTerminal.id }).catch(() => {})
    if (current && current.phase !== "canceled" && !(current.phase === "signed_in" && current.instance)) await rpc().call("providers.accounts.login.cancel", { id: current.id }).catch(() => {})
  }, [legacyTerminal])

  const restart = useCallback(async (patch: Partial<AccountLoginStartParams>) => {
    const previous = paramsRef.current
    const current = loginRef.current
    if (!previous) return
    if (current) await rpc().call("providers.accounts.login.cancel", { id: current.id }).catch(() => {})
    submittedRef.current = false
    setCodeState("idle")
    await start({ ...previous, ...patch })
  }, [start])

  const retry = useCallback(async () => {
    if (paramsRef.current) await restart({})
  }, [restart])

  const submitCode = useCallback(async (code: string) => {
    const current = loginRef.current
    if (!current) return
    submittedRef.current = true
    setCodeState("sending")
    try {
      adopt(await rpc().call("providers.accounts.login.input", { id: current.id, code: code.trim() }))
      setCodeState((state) => (state === "sending" ? "idle" : state))
    } catch {
      submittedRef.current = false
      setCodeState("wrong")
      setWrongCodes((count) => count + 1)
    }
  }, [adopt])

  const signInLegacy = useCallback(async (provider: ProviderInstance) => {
    setStarting(true)
    setFailure(null)
    try {
      setLegacyTerminal(await rpc().call("providers.accounts.sign_in", provider))
    } catch (error) {
      setFailure(errorText(error))
    } finally {
      setStarting(false)
    }
  }, [])

  // Look at what the daemon has once, in case the list changed behind the sheet.
  useEffect(() => {
    if (login?.phase === "signed_in") void refreshAccounts()
  }, [login?.phase])

  return { login, legacyTerminal, failure, starting, codeState, wrongCodes, start, retry, restart, submitCode, cancel, signInLegacy }
}

