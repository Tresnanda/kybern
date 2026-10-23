/**
 * Real threads, real memory. The full app (perf/memory/app.ts) against a
 * scratch daemon serving a stripped copy of a real store: each thread is
 * opened, every page of its history loaded, its turns visited, then Home.
 * Footprint, JS heap and the app's own memory log (`perf/memoryLog.ts`) are
 * sampled after each step.
 *
 *   KYBERN_DATA_DIR=/Users/mymac/projects/ade-gpuix-scratch/memlog-real \
 *   NAPI_RS_NATIVE_LIBRARY_PATH=<addon> bun perf/memlog/real.ts <label> [thread ...]
 *
 * The store copy must hold only idle threads without provider sessions, and the
 * daemon must run under `env -i HOME=<scratch> PATH=/usr/bin:/bin`, so nothing
 * can resume a real agent session.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../../src/requests/harness.ts'

const label = process.argv[2] ?? 'run'
const data = process.env.KYBERN_DATA_DIR!
assert(data?.includes('scratch'), 'Explicit scratch data directory required')
const out = path.join(data, 'results', label)
mkdirSync(out, { recursive: true })
const wheel = path.join(data, 'bench-wheel.dylib')
if (!existsSync(wheel)) execFileSync('clang', ['-dynamiclib', '-fobjc-arc', '-framework', 'Cocoa', '-framework', 'CoreGraphics', path.join(import.meta.dir, '../bench/wheel.m'), '-o', wheel])

const client = path.join(data, `client-${label}`)
mkdirSync(client, { recursive: true })
const f = await launchFixture(path.join(import.meta.dir, 'app.ts'), {
  KYBERN_DATA_DIR: data, KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_GPUIX_RESOURCES: '', KYBERND: '', KYBERN_BUNDLED_CLI: '',
  KYBERN_CLIENT_CONFIG_DIR: client, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(client, 'credentials'), KYBERN_GPUIX_THREAD: '',
  GPUIX_BACKGROUND: '1', KYBERN_MEMORY_COUNTERS: '1', KYBERN_APPEARANCE: 'dark', KYBERN_PACING_IGNORE_PHYSICAL_MOUSE: '1',
  KYBERN_MEMORY_LOG_MS: process.env.KYBERN_MEMORY_LOG_MS ?? '3000',
})
const rows: Record<string, unknown>[] = []
try {
  await f.app.getByTestId('app-ready').waitFor()
  const port = (name: string) => JSON.parse(readFileSync(path.join(client, `${name}-control.json`), 'utf8')).port as number
  for (const until = Date.now() + 20000; ; await Bun.sleep(50)) { try { port('memory'); break } catch { assert(Date.now() < until) } }
  const control = async (action: string, args: Record<string, unknown> = {}, memory = false) => {
    const res = await fetch(`http://127.0.0.1:${port(memory ? 'memory' : 'bench')}`, { method: 'POST', body: JSON.stringify({ action, ...args }) })
    if (!res.ok) throw Error(await res.text())
    return res.json() as Promise<Record<string, any>>
  }
  const sample = async (name: string, extra: Record<string, unknown> = {}) => {
    const text = execFileSync('footprint', ['-p', String(f.pid)], { encoding: 'utf8' })
    const size = (re: RegExp) => { const m = text.match(re); return m ? Math.round(Number(m[1]) * (m[2] === 'GB' ? 1024 : m[2] === 'KB' ? 1 / 1024 : m[2] === 'B' ? 1 / 1048576 : 1)) : null }
    const category = (c: string) => size(new RegExp(`^\\s*([\\d.]+) (B|KB|MB|GB)\\s+[\\d.]+ \\w+\\s+[\\d.]+ \\w+\\s+\\d+\\s+${c.replace(/[()]/g, '\\$&')}$`, 'm'))
    const stats = await control('stats', {}, true)
    const row = {
      name, at: Date.now(), ...extra,
      footprintMB: size(/phys_footprint:\s+([\d.]+) (\w+)/), peakMB: size(/phys_footprint_peak:\s+([\d.]+) (\w+)/),
      jsTagMB: category('App-Specific Tag 1'), ioSurfaceMB: category('IOSurface'), ioAccelMB: category('IOAccelerator'), mallocSmallMB: category('Malloc Small'), untaggedMB: category('Untagged'),
      heapMB: Math.round(stats.heap.heapSize / 1048576), capacityMB: Math.round(stats.heap.heapCapacity / 1048576), extraMB: Math.round(stats.heap.extraMemorySize / 1048576), objects: stats.heap.objectCount,
      blocks: stats.blocks, more: stats.nextBeforeSeq != null,
    }
    rows.push({ ...row, native: stats.native })
    writeFileSync(path.join(out, 'results.json'), JSON.stringify(rows, null, 2))
    console.log(JSON.stringify(row))
    return stats
  }
  while (!(await control('state')).listsLoaded) await Bun.sleep(50)
  await control('home'); await Bun.sleep(5000)
  await sample('home-initial')
  const replayed = process.env.KYBERN_MEMLOG_REPLAY
  if (replayed) {
    // Stream a stored thread back through the live path, sampling as it goes.
    const memlog = async (args: Record<string, unknown> = {}) => (await fetch(`http://127.0.0.1:${port('memlog')}`, { method: 'POST', body: JSON.stringify({ action: 'status', ...args }) })).json() as Promise<Record<string, any>>
    for (let round = 1; round <= Number(process.env.KYBERN_MEMLOG_ROUNDS ?? 1); round++) {
    if (round > 1) { await control('home'); await Bun.sleep(2000); await sample(`round-${round - 1}-home`) }
    let status = await memlog({ action: 'replay', thread: replayed, perFrame: Number(process.env.KYBERN_MEMLOG_PER_FRAME ?? 4) })
    const trace: unknown[] = []
    for (let next = 0.1; !status.done; await Bun.sleep(150)) {
      status = await memlog()
      const native = (await control('stats', {}, true)).native
      trace.push({ t: Date.now(), applied: status.applied, blocks: status.blocks, lastKind: status.lastKind, lastChars: status.lastChars, largeMB: Math.round(native.largeAllocations.currentBytes / 1048576), largePeakMB: Math.round(native.largeAllocations.peakBytes / 1048576), dispatch: native.dispatchFrames, layoutNodes: native.layoutNodeHighWater, arena: native.appElementArenaBytes })
      writeFileSync(path.join(out, 'trace.json'), JSON.stringify(trace))
      // With `MallocStackLogging=lite`: the live allocation stacks once large allocations pass KYBERN_MEMLOG_SNAPSHOT_MB.
      const snapshotAt = Number(process.env.KYBERN_MEMLOG_SNAPSHOT_MB ?? 0)
      if (snapshotAt && native.largeAllocations.currentBytes > snapshotAt * 1048576 && !existsSync(path.join(out, 'spike.txt'))) {
        writeFileSync(path.join(out, 'spike.txt'), execFileSync('malloc_history', [String(f.pid), '-callTree', '-invert', '-ignoreThreads'], { encoding: 'utf8', maxBuffer: 1 << 30, env: { ...process.env, MallocStackLogging: '' } }))
        console.error('spike snapshot at', native.largeAllocations.currentBytes)
      }
      if (status.applied / status.total >= next || status.done) { await sample(`replay-${Math.round(status.applied / status.total * 100)}%`, { applied: status.applied }); next += 0.1 }
    }
    await Bun.sleep(3000)
    await sample(`replay-done-${round}`)
    }
  }
  const threads = process.argv.slice(3)
  for (const thread of threads) {
    let t = performance.now()
    await control('open', { thread }); await Bun.sleep(3000)
    await sample(`${thread.slice(0, 8)}-open`, { ms: Math.round(performance.now() - t) })
    t = performance.now()
    const history = await control('older-all', {}, true)
    await sample(`${thread.slice(0, 8)}-history`, { ms: Math.round(performance.now() - t) })
    const items = history.blocks as number
    const step = Math.max(1, Math.floor(items / 60))
    for (let i = items - 1; i >= 0; i -= step) { await control('jump', { index: i }, true); await Bun.sleep(60) }
    await Bun.sleep(1000)
    await sample(`${thread.slice(0, 8)}-visited`)
  }
  await control('home'); await Bun.sleep(5000)
  await sample('home-after')
  await Bun.sleep(Number(process.env.KYBERN_MEMLOG_IDLE_MS ?? 60000))
  await sample('home-idle')
  // With `MallocStackLogging=1` in the environment: what was live at the footprint peak.
  if (process.env.MallocStackLogging === 'full') {
    const file = path.join(out, 'high-water.txt')
    writeFileSync(file, execFileSync('malloc_history', [String(f.pid), '-highWaterMark', '-callTree', '-invert', '-ignoreThreads'], { encoding: 'utf8', maxBuffer: 1 << 30, env: { ...process.env, MallocStackLogging: '' } }))
    console.log('high water:', file)
  }
} finally {
  await f.close()
  console.log('memory log:', path.join(client, 'memory.jsonl'))
}
