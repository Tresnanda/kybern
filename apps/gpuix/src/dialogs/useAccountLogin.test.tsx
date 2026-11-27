// Following one sign-in: it is reported lost when the machine forgets it or stops answering, picked up again when it
// is still there, and a code is only called wrong when the sign-in says so.
import { afterEach, describe, expect, test } from 'bun:test'
import { useEffect } from 'react'
import { ConnectionClosedError, RpcCallError, type KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import type { AccountLogin } from '../../../../packages/kybern-client/src/types.ts'
import { harness } from './gpuixHarness.tsx'
import { useAccountLogin, type AccountLoginApi } from './useAccountLogin.ts'

const login = (patch: Partial<AccountLogin> = {}): AccountLogin => ({ id: 'l1', kind: 'claude-code', mode: 'paste', phase: 'waiting', expires_at: '2027-01-01T00:00:00Z', ...patch })
const ended = () => new RpcCallError({ code: -32602, message: 'This sign-in has ended. Start again.' })

let mounted: ReturnType<typeof harness> | null = null
afterEach(() => { mounted?.close(); mounted = null })
const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms))

async function follow(handlers: Record<string, () => unknown>) {
  const calls: string[] = []
  const client = {
    call: async (method: string) => {
      calls.push(method)
      if (method === 'providers.accounts.login.start' && !handlers[method]) return login()
      return handlers[method]?.() ?? login()
    },
    onNotification: () => () => {},
  } as unknown as KybernClient
  const seen: { api: AccountLoginApi } = { api: null as unknown as AccountLoginApi }
  function Probe() {
    const api = useAccountLogin(client, { openPage: false, pollMs: 5, lostAfterMs: 30 })
    seen.api = api
    useEffect(() => { void api.start({ kind: 'claude-code', mode: 'paste' }) }, [])
    return null
  }
  mounted = harness()
  mounted.render(<Probe />)
  await settle()
  return { calls, api: () => seen.api }
}

describe('a running sign-in', () => {
  test('the machine no longer knows it: lost, and the polling stops', async () => {
    const run = await follow({ 'providers.accounts.login.get': () => { throw ended() } })
    expect(run.api().lost).toBe('ended')
    const asked = run.calls.length
    await settle()
    expect(run.calls.length).toBe(asked)
  })

  test('the machine stops answering: lost after a while, not at the first miss', async () => {
    let misses = 0
    const run = await follow({ 'providers.accounts.login.get': () => { if (misses++ < 2) throw new ConnectionClosedError(); return login() } })
    expect(run.api().lost).toBeNull()
    mounted!.close()
    const gone = await follow({ 'providers.accounts.login.get': () => { throw new ConnectionClosedError() } })
    await settle(100)
    expect(gone.api().lost).toBe('offline')
  })

  test('a question that is never answered counts as silence', async () => {
    const run = await follow({ 'providers.accounts.login.get': () => new Promise(() => {}) })
    await settle(100)
    expect(run.api().lost).toBe('offline')
  })

  test('“Try again” picks up a sign-in that is still there instead of starting over', async () => {
    let away = true
    const run = await follow({ 'providers.accounts.login.get': () => { if (away) throw new ConnectionClosedError(); return login() } })
    await settle(100)
    expect(run.api().lost).toBe('offline')
    away = false
    await run.api().retry()
    await settle()
    expect(run.api().lost).toBeNull()
    expect(run.calls).not.toContain('providers.accounts.login.cancel')
    expect(run.calls.filter((method) => method === 'providers.accounts.login.start')).toHaveLength(1)
  })

  test('“Try again” starts over when it is gone', async () => {
    let gone = true
    const run = await follow({ 'providers.accounts.login.get': () => { if (gone) throw ended(); return login() } })
    await run.api().retry()
    gone = false
    await settle()
    expect(run.calls.filter((method) => method === 'providers.accounts.login.start')).toHaveLength(2)
    expect(run.api().lost).toBeNull()
  })
})

describe('a pasted code', () => {
  test('a dropped connection while sending it is not a wrong code', async () => {
    const run = await follow({ 'providers.accounts.login.input': () => { throw new ConnectionClosedError() } })
    await run.api().submitCode('abc')
    await settle()
    expect(run.api().codeState).toBe('unsent')
    expect(run.api().wrongCodes).toBe(0)
  })

  test('an ended sign-in is not a wrong code either', async () => {
    let over = false
    const run = await follow({
      'providers.accounts.login.input': () => { over = true; throw ended() },
      'providers.accounts.login.get': () => { if (over) throw ended(); return login() },
    })
    await run.api().submitCode('abc')
    await settle()
    expect(run.api().lost).toBe('ended')
    expect(run.api().wrongCodes).toBe(0)
  })

  test('the sign-in’s own refusal is', async () => {
    let refused = false
    const answer = () => (refused ? login({ phase: 'starting', error: 'That code didn’t work.' }) : login())
    const run = await follow({ 'providers.accounts.login.input': () => { refused = true; return login({ phase: 'verifying' }) }, 'providers.accounts.login.get': answer })
    await run.api().submitCode('abc')
    await settle()
    expect(run.api().codeState).toBe('wrong')
    expect(run.api().wrongCodes).toBe(1)
  })
})
