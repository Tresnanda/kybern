import { describe, expect, test } from 'bun:test'
import type { NetworkStatus } from '../../../../packages/kybern-client/src/types.ts'
import { MachineSetup, enableUnconfigured, type SetupClient, type SetupDependencies, type SetupRow, type SetupTarget } from './setup.ts'

function client(status: Partial<NetworkStatus>) {
  const calls: [string, unknown][] = []
  return { calls, client: { call: async (method: string, params: unknown) => {
    calls.push([method, params])
    return { ...status, ...(method === 'network.set_enabled' ? { enabled: true, configured: true } : {}) } as NetworkStatus
  } } as SetupClient }
}
describe('guarded activation', () => {
  test('uses the authenticated conditional RPC only on a never-configured new daemon', async () => {
    const f = client({ enabled: false, configured: false })
    expect((await enableUnconfigured(f.client)).enabled).toBe(true)
    expect(f.calls).toEqual([['network.status', {}], ['network.set_enabled', { enabled: true, only_if_unconfigured: true }]])
  })
  test('preserves explicit off and never sends a conditional parameter to an old daemon', async () => {
    const off = client({ enabled: false, configured: true })
    expect((await enableUnconfigured(off.client)).enabled).toBe(false)
    expect(off.calls).toHaveLength(1)
    const legacy = client({ enabled: false })
    await expect(enableUnconfigured(legacy.client)).rejects.toThrow('Update Kybern')
    expect(legacy.calls).toHaveLength(1)
    const on = client({ enabled: true })
    expect((await enableUnconfigured(on.client)).enabled).toBe(true)
    expect(on.calls).toHaveLength(1)
  })
  test('cancellation between status and activation does not turn on the remote', async () => {
    const abort = new AbortController(), f = client({ configured: false, enabled: false })
    const original = f.client.call
    f.client.call = (async (...args: Parameters<SetupClient['call']>) => { const result = await original(...args); abort.abort(); return result }) as SetupClient['call']
    await expect(enableUnconfigured(f.client, abort.signal)).rejects.toThrow()
    expect(f.calls).toHaveLength(1)
  })
})
const target = (id: string, access: SetupTarget['access'] = 'ssh'): SetupTarget => ({ id, name: id, access, target: access === 'ssh' ? id : undefined })
const missing = () => Object.assign(Error('Choose Install and connect.'), { name: 'MissingDaemon' })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe('machine setup lifecycle', () => {
  test('probes installed machines, offers a missing daemon, and never runs tailnet-only shell commands', async () => {
    const called: [string, boolean][] = []
    const setup = new MachineSetup({
      discover: async () => [target('installed', 'paired'), target('missing'), target('discovered', 'guidance'), target('off', 'paired')],
      connect: async (item, install) => { called.push([item.id, install]); if (item.id === 'missing' && !install) throw missing(); return { enabled: item.id !== 'off', machineId: item.id } },
    })
    await setup.start()
    expect(called).toEqual([['installed', false], ['missing', false], ['off', false]])
    expect(setup.get().rows.map(row => row.phase)).toEqual(['ready', 'install', 'access', 'off'])
    await setup.retry('missing', true)
    expect(called.at(-1)).toEqual(['missing', true])
    expect(setup.get().rows.find(row => row.target.id === 'missing')?.phase).toBe('ready')
  })
  test('bounds concurrent work, coalesces checks/retries and cancels queued work', async () => {
    let active = 0, peak = 0, calls = 0
    const setup = new MachineSetup({
      discover: async () => Array.from({ length: 10 }, (_, i) => target(`host${i}`)),
      connect: async (_, __, ___, signal) => {
        calls++; peak = Math.max(peak, ++active)
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
        active--; return { enabled: true }
      },
    })
    const first = setup.start(), same = setup.start()
    expect(same).toBe(first)
    await tick()
    expect(calls).toBe(3)
    const retry = setup.retry('host0')
    setup.cancelAll()
    await Promise.all([first, retry])
    expect(peak).toBe(3)
    expect(calls).toBe(3)
    expect(setup.get().rows.every(row => row.phase === 'canceled')).toBe(true)
  })
  test('persists failures for retry, and restart never resumes an install', async () => {
    let rows: SetupRow[] = [], attempts = 0
    const deps: SetupDependencies = {
      discover: async () => [target('offline')], save: value => { rows = value },
      connect: async () => { if (++attempts === 1) throw Error('SSH could not sign in. Load your key, then retry.'); return { enabled: true } },
    }
    const setup = new MachineSetup(deps)
    await setup.start()
    expect(rows[0]?.phase).toBe('error')
    const restored = new MachineSetup(deps, rows)
    await restored.start()
    expect(attempts).toBe(1)
    await restored.retry('offline')
    expect(restored.get().rows[0]?.phase).toBe('ready')
    const interrupted = new MachineSetup(deps, [{ target: target('offline'), phase: 'installing', detail: 'Installing' }])
    await interrupted.start()
    expect(interrupted.get().rows[0]?.phase).toBe('canceled')
    expect(attempts).toBe(2)
  })
  test('removed trust is never replayed from persisted rows', async () => {
    let calls = 0
    const setup = new MachineSetup({ discover: async () => [], connect: async () => { calls++; return { enabled: true } } }, [{ target: target('removed'), phase: 'install', detail: 'Install' }])
    await setup.retry('removed', true)
    expect(calls).toBe(0)
    expect(setup.get().rows[0]?.phase).toBe('access')
  })
  test('turning off during discovery prevents all new tasks', async () => {
    let finish!: (value: SetupTarget[]) => void, calls = 0
    const setup = new MachineSetup({ discover: () => new Promise(resolve => { finish = resolve }), connect: async () => { calls++; return { enabled: true } } })
    const work = setup.start(); setup.cancelAll(); finish([target('host')]); await work
    expect(calls).toBe(0)
  })
  test('turning back on while a canceled scan settles checks the fresh trusted inventory', async () => {
    let finish!: (value: SetupTarget[]) => void, scans = 0, calls = 0
    const setup = new MachineSetup({
      discover: () => ++scans === 1 ? new Promise(resolve => { finish = resolve }) : Promise.resolve([target('host')]),
      connect: async () => { calls++; return { enabled: true } },
    })
    const old = setup.start(); setup.cancelAll()
    const fresh = setup.start(true)
    finish([target('host')])
    await Promise.all([old, fresh])
    expect(scans).toBe(2)
    expect(calls).toBe(1)
    expect(setup.get().rows[0]?.phase).toBe('ready')
  })

})
