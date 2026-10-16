import { expect, test } from 'bun:test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { DaemonInfo } from '../../../../packages/kybern-client/src/types.ts'
import { createLocalDaemonResolver, daemonNeedsRestart, daemonRpc, preferredDaemonPort, type DaemonDependencies } from './daemon.ts'

const info = { version: '0.9.1', protocol_version: 1, started_at: '2099-01-01T00:00:00Z' } as DaemonInfo
const fakeChild = () => ({ exitCode: null, signalCode: null }) as ChildProcess
async function fixture(run: (root: string, binary: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'gpuix-daemon-'))
  try { const binary = path.join(root, 'kybernd'); await writeFile(binary, 'fixture'); await run(root, binary) }
  finally { await rm(root, { recursive: true, force: true }) }
}
test('daemon version, protocol and build time match the Tauri restart policy', () => {
  expect(daemonNeedsRestart(info, '0.9.1', 1)).toBe(false)
  expect(daemonNeedsRestart(info, '0.9.2')).toBe(true)
  expect(daemonNeedsRestart({ ...info, protocol_version: 0 }, '0.9.1')).toBe(true)
  expect(daemonNeedsRestart(info, '0.9.1', Date.parse(info.started_at) + 1)).toBe(true)
})
test('durable desktop port survives daemon discovery removal; malformed ports fail', () => fixture(async root => {
  expect(await preferredDaemonPort(root)).toBe(0)
  await writeFile(path.join(root, 'desktop.port'), '4321')
  expect(await preferredDaemonPort(root)).toBe(4321)
  await writeFile(path.join(root, 'daemon.port'), '1234')
  expect(await preferredDaemonPort(root)).toBe(1234)
  for (const value of ['0', '65536', '-1', '1e3', 'abc']) {
    await writeFile(path.join(root, 'daemon.port'), value)
    await expect(preferredDaemonPort(root)).rejects.toThrow('Invalid port')
  }
}))
test('concurrent startup returns one announcement endpoint before recovery publishes daemon.port', () => fixture(async (root, binary) => {
  let launches = 0
  await writeFile(path.join(root, 'desktop.port'), '4321')
  const resolver = createLocalDaemonResolver({ root, binary, version: '0.9.1' }, {
    rpc: (async () => { throw Error('not ready') }) as typeof daemonRpc,
    launch: async (_binary, args) => {
      launches++
      expect(args).toContain('4321')
      const id = args.at(-1)!
      await writeFile(path.join(root, 'daemon.token'), 'fixture-auth')
      await writeFile(path.join(root, `.desktop-startup-${id}.json`), JSON.stringify({ port: 4321, protocol_version: 1 }))
      return fakeChild()
    },
  })
  const endpoints = await Promise.all([resolver(), resolver(), resolver()])
  expect(launches).toBe(1)
  for (const endpoint of endpoints) expect(endpoint).toEqual({ url: 'ws://127.0.0.1:4321/ws', token: 'fixture-auth' })
  expect(await resolver()).toEqual(endpoints[0])
  expect(launches).toBe(1)
  expect(await readFile(path.join(root, 'desktop.port'), 'utf8')).toBe('4321')
}))
test('external URL never starts or shuts down a daemon, including incompatible versions', () => fixture(async root => {
  for (const remote of [info, { ...info, protocol_version: 0 }, null]) {
    const methods: string[] = []
    const resolver = createLocalDaemonResolver({ root, url: 'http://127.0.0.1:4312', token: 'fixture' }, {
      rpc: (async (_endpoint, method) => { methods.push(method); if (!remote) throw Error('offline'); return remote }) as typeof daemonRpc,
      launch: async () => { throw Error('must never launch') },
    })
    if (remote?.protocol_version === 1) expect((await resolver()).url).toBe('ws://127.0.0.1:4312/ws')
    else await expect(resolver()).rejects.toThrow(remote ? 'incompatible' : 'not reachable')
    expect(methods).toEqual(['daemon.info'])
  }
}))
test('stale managed daemon must finish discovery-file cleanup before successor launch', () => fixture(async (root, binary) => {
  await writeFile(path.join(root, 'daemon.port'), '4321'); await writeFile(path.join(root, 'daemon.listen'), 'fixture'); await writeFile(path.join(root, 'daemon.token'), 'fixture')
  let stopped = false, launched = false, slept = false
  const dependencies: Partial<DaemonDependencies> = {
    rpc: (async (_endpoint, method) => { if (method === 'daemon.shutdown') { stopped = true; return {} }; if (stopped) throw Error('closed'); return { ...info, version: '0.0.0' } }) as typeof daemonRpc,
    sleep: async () => { expect(stopped).toBe(true); expect(launched).toBe(false); slept = true; await rm(path.join(root, 'daemon.port')); await rm(path.join(root, 'daemon.listen')) },
    launch: async (_binary, args) => { launched = true; expect(slept).toBe(true); await writeFile(path.join(root, `.desktop-startup-${args.at(-1)}.json`), JSON.stringify({ port: 4321, protocol_version: 1 })); return fakeChild() },
  }
  expect((await createLocalDaemonResolver({ root, binary, version: '0.9.1' }, dependencies)()).url).toBe('ws://127.0.0.1:4321/ws')
  expect(stopped && launched).toBe(true)
}))
test('early daemon exit fails instead of reusing a dead startup endpoint', () => fixture(async (root, binary) => {
  const resolver = createLocalDaemonResolver({ root, binary, version: '0.9.1' }, {
    launch: async () => ({ exitCode: 1, signalCode: null }) as ChildProcess,
  })
  await expect(resolver()).rejects.toThrow('exited before announcing')
}))

test('separate window resolvers share the announcement while daemon recovery is pending', () => fixture(async (root, binary) => {
  let launches = 0
  const dependencies: Partial<DaemonDependencies> = {
    rpc: (async () => { throw Error('recovery pending') }) as typeof daemonRpc,
    launch: async (_binary, args) => {
      launches++
      await writeFile(path.join(root, 'daemon.token'), 'fixture')
      await writeFile(path.join(root, `.desktop-startup-${args.at(-1)}.json`), JSON.stringify({ port: 4321, protocol_version: 1 }))
      return { ...fakeChild(), pid: process.pid } as ChildProcess
    },
  }
  const a = createLocalDaemonResolver({ root, binary, version: '0.9.1' }, dependencies)
  const b = createLocalDaemonResolver({ root, binary, version: '0.9.1' }, dependencies)
  expect(await a()).toEqual(await b())
  expect(launches).toBe(1)
}))
