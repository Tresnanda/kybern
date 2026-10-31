import { expect, test } from 'bun:test'
import { discoveredServers, projectRootsOnMachines, serverTestId, startServerDiscovery, type MachineServers, type ServerMachine } from './discovery.ts'
import type { PreviewServersListResult, PreviewServer } from '../../../../packages/kybern-client/src/types.ts'
import type { LogicalProject } from '../../../../packages/kybern-client/src/machineMerge.ts'
const server = (port: number, cwd = '/other'): PreviewServer => ({ port, url: `http://localhost:${port}`, host: 'localhost', cwd })
const reply = (...servers: PreviewServer[]): PreviewServersListResult => ({ servers, scanned_at: '2026-10-31', method: 'test' })
const machine = (machineId: string, offline = false): ServerMachine => ({ machineId, name: machineId, offline, isLocal: machineId === 'local' })
const turn = () => new Promise<void>(resolve => setImmediate(resolve))

test('All includes every machine, scoped identities keep equal ports distinct, logical checkout wins', () => {
  const projects = [{ instances: [{ machineId: 'local', project: { id: 'a', path: '/work/app' } }, { machineId: 'remote', project: { id: 'b', path: 'C:\\work\\app' } }] }] as LogicalProject[]
  const roots = projectRootsOnMachines(projects, 'a', 'local')
  expect(roots.get('remote')).toEqual(['C:\\work\\app'])
  expect(projectRootsOnMachines(projects, 'a', 'remote').size).toBe(0)
  const results: MachineServers[] = [
    { machine: machine('local'), phase: 'ready', servers: [server(5173)] },
    { machine: { ...machine('remote'), roots: roots.get('remote') }, phase: 'ready', servers: [server(5173, 'C:\\work\\app\\web'), server(3000, 'C:\\work\\application')] },
  ]
  expect(discoveredServers(results).map(s => [s.machine.machineId, s.port, s.in_project])).toEqual([['remote', 5173, true], ['local', 5173, false], ['remote', 3000, false]])
  expect(discoveredServers(results, 'local').map(s => s.port)).toEqual([5173])
  expect(discoveredServers(results, 'missing')).toEqual([])
  const samePort = discoveredServers(results).filter(s => s.port === 5173)
  expect(new Set(samePort.map(serverTestId)).size).toBe(2)
  expect(samePort.map(serverTestId)).toEqual(['preview-server-remote-5173', 'preview-server-local-5173'])
})

test('logical projects retain every clone on a machine and match Windows roots without case', () => {
  const projects = [{ instances: [
    { machineId: 'local', project: { id: 'a', path: '/work/app' } },
    { machineId: 'local', project: { id: 'b', path: '/work/other-clone' } },
    { machineId: 'remote', project: { id: 'c', path: 'C:\\Work\\App\\' } },
    { machineId: 'remote', project: { id: 'd', path: '\\\\SERVER\\Share\\App' } },
    { machineId: 'local', project: { id: 'duplicate', path: '/work/app' } },
  ] }] as LogicalProject[]
  const roots = projectRootsOnMachines(projects, 'b', 'local')
  expect(roots.get('local')).toEqual(['/work/app', '/work/other-clone'])
  expect(roots.get('remote')).toEqual(['C:\\Work\\App\\', '\\\\SERVER\\Share\\App'])
  const results: MachineServers[] = [
    { machine: { ...machine('local'), roots: roots.get('local') }, phase: 'ready', servers: [server(3000, '/work/app/web'), server(3001, '/work/other-clone/web'), server(3002, '/WORK/app')] },
    { machine: { ...machine('remote'), roots: roots.get('remote') }, phase: 'ready', servers: [server(4000, 'c:/work/app/web'), server(4001, '//server/share/app/web'), server(4002, 'C:/Work/Application')] },
  ]
  expect(discoveredServers(results).filter(s => s.in_project).map(s => s.port)).toEqual([3000, 3001, 4000, 4001])
})

test('bounded queue publishes partial success and errors without waiting for a slow machine; stop cancels queued scans', async () => {
  const calls: string[] = [], snapshots: MachineServers[][] = []
  let finishSlow!: (reply: PreviewServersListResult) => void
  let active = 0, peak = 0
  const stop = startServerDiscovery(['slow', 'fast', 'broken', 'last'].map(id => machine(id)).concat(machine('offline', true)), async m => {
    calls.push(m.machineId); peak = Math.max(peak, ++active)
    try {
      if (m.machineId === 'slow') return await new Promise<PreviewServersListResult>(resolve => { finishSlow = resolve })
      if (m.machineId === 'broken') throw Error('unreachable')
      return reply(server(5173))
    } finally { active-- }
  }, value => snapshots.push(value), { concurrency: 2, pollMs: 1000 })
  await turn(); await turn()
  expect(peak).toBe(2)
  expect(calls).toEqual(['slow', 'fast', 'broken', 'last'])
  const partial = snapshots.at(-1)!
  expect(partial.find(r => r.machine.machineId === 'slow')?.phase).toBe('loading')
  expect(partial.find(r => r.machine.machineId === 'fast')?.servers).toHaveLength(1)
  expect(partial.find(r => r.machine.machineId === 'broken')?.phase).toBe('error')
  expect(partial.find(r => r.machine.machineId === 'offline')?.phase).toBe('offline')
  stop(); const count = snapshots.length
  finishSlow(reply(server(3000))); await turn()
  expect(snapshots).toHaveLength(count)
  let hiddenCalls = 0
  const stopHidden = startServerDiscovery([machine('hidden')], async () => { hiddenCalls++; return reply() }, () => {})
  stopHidden(); await turn()
  expect(hiddenCalls).toBe(0)
})

test('a fast machine refreshes while a slow machine is still loading and failed refresh drops stale results', async () => {
  let count = 0, latest: MachineServers[] = [], finishSlow!: (reply: PreviewServersListResult) => void
  let refreshed!: () => void
  const done = new Promise<void>(resolve => { refreshed = resolve })
  const stop = startServerDiscovery([machine('slow'), machine('fast')], async m => {
    if (m.machineId === 'slow') return await new Promise<PreviewServersListResult>(resolve => { finishSlow = resolve })
    if (++count === 1) return reply(server(3000))
    throw Error('gone')
  }, value => { latest = value; if (value.some(r => r.phase === 'error')) refreshed() }, { concurrency: 2, pollMs: 1 })
  await done; stop(); finishSlow(reply())
  expect(count).toBe(2)
  expect(latest[0]!.phase).toBe('loading')
  expect(latest[1]!.phase).toBe('error')
  expect(latest[1]!.servers).toEqual([])
})
