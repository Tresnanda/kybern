import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { bootstrapSsh, listSshHosts, parseProbe, runSsh, type BootstrapDependencies, type BootstrapProgress } from './ssh.ts'
import type { CommandPlan } from '../shell/platform.ts'
const machine = 'os=Linux\narch=aarch64\nkybernd=/fixture/kybernd\nversion=0.9.1\ncurl=1\nport=4173\ntoken=fixture-bootstrap\n'
function fixture() {
  const plans: CommandPlan[] = [], paired: unknown[] = [], stopped: string[] = [], progress: BootstrapProgress[] = []
  const deps: BootstrapDependencies = {
    version: '0.9.1', run: async plan => { plans.push(plan); return machine },
    tunnel: async () => 12345, stop: id => { stopped.push(id) },
    info: async () => ({ version: '0.9.1', hostname: 'scratch', environment_id: 'fixture-environment' }),
    shutdown: async () => {}, sleep: async () => {},
    pair: async (...args) => { paired.push(args); return { machineId: 'fixture-id', name: 'Fixture' } },
  }
  return { deps, plans, paired, stopped, progress, report: (value: BootstrapProgress) => progress.push(value) }
}
describe('SSH setup process boundary', () => {
  test('reuses a healthy daemon and pairs only with verified identity through loopback', async () => {
    const f = fixture()
    await bootstrapSsh({ id: 'fixture-id', name: 'Fixture', target: 'deploy@fixture:2222', data_dir: "/scratch/with ' quote" }, f.report, f.deps)
    expect(f.plans).toHaveLength(1)
    expect(f.plans[0]!.args).toContain('2222')
    expect(f.plans[0]!.args).not.toContain('fixture-bootstrap')
    expect(f.plans[0]!.stdin).toContain(String.raw`'/scratch/with '\'' quote'`)
    expect(f.paired[0]).toEqual([12345, 'fixture-bootstrap', expect.objectContaining({id:'fixture-id'}), expect.objectContaining({target:'deploy@fixture',port:2222,local_port:12345}), 'fixture-environment'])
    expect(f.progress.map(p => `${p.step}:${p.state}`)).toEqual(['connect:running','connect:done','install:done','start:running','start:done','pair:running','pair:done'])
  })
  test('installs a missing daemon and waits for a reachable daemon before pairing', async () => {
    const f = fixture(); let probes = 0, checks = 0
    f.deps.info = async () => { if (++checks === 1) throw Error('not started'); return {version:'0.9.1',hostname:'scratch',environment_id:'fixture-environment'} }
    f.deps.run = async plan => { f.plans.push(plan); if (plan.stdin?.includes('printf')) return ++probes === 1 ? 'os=Linux\narch=aarch64\ncurl=1\n' : machine; return '' }
    await bootstrapSsh({ name:'Fixture', target:'fixture' }, f.report, f.deps)
    expect(f.plans.some(p => p.stdin?.includes("curl --proto '=https'"))).toBe(true)
    expect(f.plans.some(p => p.stdin?.includes('nohup kybernd'))).toBe(true)
    expect(f.paired).toHaveLength(1)
  })
  test('stops owned tunnel and reports the failed step without saving on an install failure', async () => {
    const f = fixture(); f.deps.run = async () => 'os=Linux\narch=aarch64\n'
    await expect(bootstrapSsh({ id:'fixture-id', name:'Fixture', target:'fixture' }, f.report, f.deps)).rejects.toThrow('curl')
    expect(f.paired).toHaveLength(0); expect(f.stopped).toEqual(['fixture-id'])
    expect(f.progress.at(-1)).toEqual(expect.objectContaining({step:'install',state:'failed'}))
  })
  test('rejects SSH argument injection before starting a process', async () => {
    const f = fixture()
    for (const target of ['-oProxyCommand=bad', 'host;touch bad', 'user@host$(whoami)', 'host:70000']) await expect(bootstrapSsh({ name:'Fixture',target }, f.report, f.deps)).rejects.toThrow()
    expect(f.plans).toHaveLength(0)
  })
  test('reads literal aliases from an isolated config', async () => {
    const dir = await mkdtemp(path.join(tmpdir(),'gpuix-ssh-'))
    try { const file = path.join(dir,'config'); await writeFile(file,'Host work staging *.private !excluded\n'); expect(await listSshHosts(file)).toEqual(['work','staging']) } finally { await rm(dir,{recursive:true,force:true}) }
  })
  test('cancellation kills only the task-owned mock process', async () => {
    const dir = await mkdtemp(path.join(tmpdir(),'gpuix-ssh-'))
    const previous = process.env.KYBERN_SSH
    try {
      const script = path.join(dir,'mock-ssh'), pidFile = path.join(dir,'pid')
      await writeFile(script, `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 30\n`, { mode: 0o700 })
      process.env.KYBERN_SSH = script
      const controller = new AbortController()
      const result = runSsh({ command:'ssh',args:[],timeoutMs:5000 },controller.signal)
      for (let i=0;i<100;i++) { try { await readFile(pidFile); break } catch { await Bun.sleep(10) } }
      const pid = Number(await readFile(pidFile,'utf8'))
      controller.abort(); await expect(result).rejects.toThrow('canceled')
      for (let i=0;i<100;i++) { try { process.kill(pid,0); await Bun.sleep(10) } catch { break } }
      expect(() => process.kill(pid,0)).toThrow()
    } finally { if (previous === undefined) delete process.env.KYBERN_SSH; else process.env.KYBERN_SSH=previous; await rm(dir,{recursive:true,force:true}) }
  })
})


describe('trusted network SSH setup', () => {
  test('automatic probing never installs or updates a missing daemon', async () => {
    const f = fixture(); f.deps.run = async plan => { f.plans.push(plan); return 'os=Linux\narch=aarch64\ncurl=1\n' }
    await expect(bootstrapSsh({ name: 'Fixture', target: 'fixture', network_setup: 'connect' }, f.report, f.deps)).rejects.toThrow('Install and connect')
    expect(f.plans).toHaveLength(1)
    expect(f.plans[0]!.args).toContain('StrictHostKeyChecking=yes')
    expect(f.paired).toHaveLength(0)
  })
  test('an old installed daemon is connected without a silent upgrade', async () => {
    const f = fixture(); f.deps.version = '9.0.0'
    await bootstrapSsh({ name: 'Fixture', target: 'fixture', network_setup: 'connect' }, f.report, f.deps)
    expect(f.plans).toHaveLength(1)
    expect(f.paired).toHaveLength(1)
  })
  test('Install and connect pins the release, verifies checksums, starts a service before pairing', async () => {
    const f = fixture(); let probes = 0
    f.deps.run = async plan => {
      f.plans.push(plan)
      if (plan.stdin?.includes("printf 'os=")) return ++probes === 1 ? 'os=Linux\narch=aarch64\ncurl=1\n' : machine
      return ''
    }
    await bootstrapSsh({ name: 'Fixture', target: 'fixture', network_setup: 'install' }, f.report, f.deps)
    const installation = f.plans.find(plan => plan.stdin?.includes("set -- --version '0.9.1'"))!
    expect(installation.stdin).toContain('$BASE/$ARCHIVE.sha256')
    expect(installation.stdin).toContain('[ "$EXPECTED" = "$ACTUAL" ]')
    expect(f.plans.some(plan => plan.stdin?.includes('set -- --service-only --port 4173'))).toBe(true)
    expect(f.plans.some(plan => plan.stdin?.includes('nohup kybernd'))).toBe(false)
    expect(f.paired).toHaveLength(1)
  })
  test('Windows provides a precise setup blocker without executing the Unix installer', async () => {
    const f = fixture(); f.deps.run = async plan => { f.plans.push(plan); return 'os=Windows_NT\narch=AMD64\n' }
    await expect(bootstrapSsh({ name: 'Fixture', target: 'fixture', network_setup: 'install' }, f.report, f.deps)).rejects.toThrow('kybern-installer.ps1')
    expect(f.plans).toHaveLength(1); expect(f.paired).toHaveLength(0)
  })
  test('a pre-aborted SSH process does not wait or throw a timer initialization error', async () => {
    const abort = new AbortController(); abort.abort()
    await expect(runSsh({ command: 'ssh', args: [], timeoutMs: 100 }, abort.signal)).rejects.toThrow('canceled')
  })
})
