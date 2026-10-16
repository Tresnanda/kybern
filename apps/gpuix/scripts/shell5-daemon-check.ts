// Real daemon process boundary, isolated from both the UI and the user's store.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createLocalDaemonResolver, daemonRpc, desktopVersion } from '../src/shell/daemon.ts'
import type { DaemonInfo } from '../../../packages/kybern-client/src/types.ts'
import type { Endpoint } from '../../../packages/kybern-client/src/client.ts'

const root = '/Users/mymac/projects/ade-gpuix-scratch/round5/shell/daemon'
const out = '/Users/mymac/projects/ade/previews/gpuix/round5/shell'
const binary = process.env.KYBERND
if (!binary) throw Error('Set KYBERND to an existing daemon binary')
await mkdir(root, { recursive: true }); await mkdir(out, { recursive: true })
// Never reuse a process from an earlier check.
try { await readFile(path.join(root, 'daemon.port')); throw Error('Scratch daemon already exists; choose a clean task directory') }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
let endpoint: Endpoint | undefined
const wait = async (test: () => Promise<boolean>) => {
  const until = Date.now() + 15000
  while (!await test()) { if (Date.now() > until) throw Error('Timed out waiting for the scratch daemon'); await Bun.sleep(50) }
}
try {
  const resolver = createLocalDaemonResolver({ root, binary, version: desktopVersion(), port: '4255' })
  const [a, b] = await Promise.all([resolver(), resolver()])
  endpoint = a
  assert.deepEqual(a, b)
  assert.equal(a.url, 'ws://127.0.0.1:4255/ws')
  await wait(async () => { try { await daemonRpc(a, 'daemon.info'); return true } catch { return false } })
  const before = await daemonRpc<DaemonInfo>(a, 'daemon.info')
  const secondWindow = createLocalDaemonResolver({ root, binary, version: desktopVersion() })
  assert.deepEqual(await secondWindow(), a)
  const reused = await daemonRpc<DaemonInfo>(a, 'daemon.info')
  assert.equal(before.started_at, reused.started_at)
  await daemonRpc(a, 'daemon.shutdown', 2000)
  await wait(async () => { try { await readFile(path.join(root, 'daemon.port')); return false } catch { return true } })
  // New window after clean shutdown must retain the paired address.
  const restarted = await createLocalDaemonResolver({ root, binary, version: desktopVersion() })()
  endpoint = restarted
  assert.equal(restarted.url, a.url)
  await wait(async () => { try { await daemonRpc(restarted, 'daemon.info'); return true } catch { return false } })
  const after = await daemonRpc<DaemonInfo>(restarted, 'daemon.info')
  assert.notEqual(after.started_at, before.started_at)
  const report = { runtime: 'Bun subprocess + installed kybernd, no native window', binary, version: after.version, port: 4255, assertions: ['concurrent startup', 'pre-ready announcement', 'second-window reuse', 'clean shutdown and restart on retained port'], passed: true }
  await writeFile(path.join(out, 'daemon-check.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally {
  if (endpoint) {
    await daemonRpc(endpoint, 'daemon.shutdown', 2000).catch(() => {})
    await wait(async () => { try { await readFile(path.join(root, 'daemon.port')); return false } catch { return true } })
    await rm(root, { recursive: true, force: true })
  }
}
