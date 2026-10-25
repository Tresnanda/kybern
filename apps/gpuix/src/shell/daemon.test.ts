import { expect, test } from 'bun:test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { DaemonInfo } from '../../../../packages/kybern-client/src/types.ts'
import { createLocalDaemonResolver, daemonNeedsRestart, daemonRpc, mayRestartDaemon, preferredDaemonPort, type DaemonDependencies } from './daemon.ts'

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
  expect((await createLocalDaemonResolver({ root, binary, version: '0.9.1', allowRestart: true }, dependencies)()).url).toBe('ws://127.0.0.1:4321/ws')
  expect(stopped && launched).toBe(true)
}))
test('a development build never shuts down a daemon it did not start', () => fixture(async (root, binary) => {
  await writeFile(path.join(root, 'daemon.port'), '4321'); await writeFile(path.join(root, 'daemon.token'), 'fixture')
  for (const existing of [{ ...info, version: '0.0.0' }, { ...info, started_at: '2000-01-01T00:00:00Z' }, { ...info, protocol_version: 0 }]) {
    const methods: string[] = []
    const resolver = createLocalDaemonResolver({ root, binary, version: '0.9.1' }, {
      rpc: (async (_endpoint, method) => { methods.push(method); return existing }) as typeof daemonRpc,
      launch: async () => { throw Error('must never launch') },
    })
    if (existing.protocol_version === 1) expect((await resolver()).url).toBe('ws://127.0.0.1:4321/ws')
    else await expect(resolver()).rejects.toThrow('KYBERN_ALLOW_DAEMON_RESTART=1')
    expect(methods).toEqual(['daemon.info'])
  }
}))
test('only the packaged app replacing its bundled kybernd, or an explicit opt-in, may restart a daemon', () => {
  const app = '/Applications/Kybern GPUIX.app/Contents/MacOS/Kybern GPUIX'
  expect(mayRestartDaemon('/Applications/Kybern GPUIX.app/Contents/MacOS/kybernd', {}, app)).toBe(true)
  expect(mayRestartDaemon('/tmp/old/kybernd', {}, app)).toBe(false)
  expect(mayRestartDaemon('/repo/target/debug/kybernd', {}, '/Users/me/.bun/bin/bun')).toBe(false)
  expect(mayRestartDaemon('/Users/me/.bun/bin/kybernd', {}, '/Users/me/.bun/bin/bun')).toBe(false)
  expect(mayRestartDaemon('/repo/target/debug/kybernd', { KYBERN_ALLOW_DAEMON_RESTART: '1' }, '/Users/me/.bun/bin/bun')).toBe(true)
  expect(mayRestartDaemon('/repo/target/debug/kybernd', { KYBERN_ALLOW_DAEMON_RESTART: 'true' }, '/Users/me/.bun/bin/bun')).toBe(false)
  // A Linux AppImage runs the copy it staged outside its mount, never another binary.
  const image = '/tmp/.mount_KybernX/usr/lib/kybern-gpuix/kybern-gpuix'
  const copy = { KYBERN_GPUIX_PACKAGED_DAEMON: '/home/me/.local/share/kybern-gpuix/bin/kybernd' }
  expect(mayRestartDaemon('/home/me/.local/share/kybern-gpuix/bin/kybernd', copy, image, 'linux')).toBe(true)
  expect(mayRestartDaemon('/tmp/.mount_KybernX/usr/lib/kybern-gpuix/kybernd', copy, image, 'linux')).toBe(false)
  expect(mayRestartDaemon('/home/me/.local/share/kybern-gpuix/bin/kybernd', copy, '/Users/me/.bun/bin/bun', 'linux')).toBe(false)
})
test('on Windows the packaged app may restart its kybernd.exe, and a development run may not', () => {
  const dir = 'C:\\Users\\me\\AppData\\Local\\Programs\\Kybern GPUIX', app = `${dir}\\Kybern GPUIX.exe`
  expect(mayRestartDaemon(`${dir}\\kybernd.exe`, {}, app, 'win32')).toBe(true)
  // Paths ignore case and forward slashes name the same file.
  expect(mayRestartDaemon('c:/users/ME/appdata/local/programs/kybern gpuix/KYBERND.EXE', {}, app, 'win32')).toBe(true)
  // The extensionless name is not what the installer ships, and another folder's daemon is not ours.
  expect(mayRestartDaemon(`${dir}\\kybernd`, {}, app, 'win32')).toBe(false)
  expect(mayRestartDaemon('C:\\old\\kybernd.exe', {}, app, 'win32')).toBe(false)
  for (const runtime of ['bun.exe', 'BUN.EXE', 'node.exe', 'bun']) {
    expect(mayRestartDaemon('C:\\repo\\target\\debug\\kybernd.exe', {}, `C:\\tools\\${runtime}`, 'win32')).toBe(false)
    expect(mayRestartDaemon('C:\\tools\\kybernd.exe', {}, `C:\\tools\\${runtime}`, 'win32')).toBe(false)
  }
  expect(mayRestartDaemon('C:\\repo\\kybernd.exe', { KYBERN_ALLOW_DAEMON_RESTART: '1' }, 'C:\\tools\\bun.exe', 'win32')).toBe(true)
  // macOS and Linux stay exact: case matters and `.exe` means nothing.
  expect(mayRestartDaemon('/opt/app/KYBERND', {}, '/opt/app/Kybern GPUIX', 'darwin')).toBe(false)
  expect(mayRestartDaemon('/opt/app/kybernd', {}, '/opt/app/bun.exe', 'linux')).toBe(true)
})
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
