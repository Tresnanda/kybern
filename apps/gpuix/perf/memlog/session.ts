/**
 * A normal working session against real threads: the most active threads
 * opened in turn with a few history pages each, the orchestrator's events
 * streamed back live, file, diff and image tabs, then Home and idle.
 * Footprint, the JS heap (with and without a full collection) and a census
 * after each phase; a heap snapshot at the end.
 *
 *   KYBERN_DATA_DIR=<stripped store copy, env -i daemon> bun perf/memlog/session.ts <label> <stream thread> <thread ...>
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../../src/requests/harness.ts'

const [label = 'session', stream, ...threads] = process.argv.slice(2)
assert(stream && threads.length, 'Name the streamed thread and the threads to visit')
const data = process.env.KYBERN_DATA_DIR!
assert(data?.includes('scratch'), 'Explicit scratch data directory required')
const out = path.join(data, 'results', label)
mkdirSync(out, { recursive: true })
const wheel = path.join(data, 'bench-wheel.dylib')
try { readFileSync(wheel) } catch { execFileSync('clang', ['-dynamiclib', '-fobjc-arc', '-framework', 'Cocoa', '-framework', 'CoreGraphics', path.join(import.meta.dir, '../bench/wheel.m'), '-o', wheel]) }
const client = path.join(data, `client-${label}`)
mkdirSync(client, { recursive: true })
const f = await launchFixture(path.join(import.meta.dir, 'app.ts'), {
  KYBERN_DATA_DIR: data, KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_GPUIX_RESOURCES: '', KYBERND: '', KYBERN_BUNDLED_CLI: '',
  KYBERN_CLIENT_CONFIG_DIR: client, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(client, 'credentials'), KYBERN_GPUIX_THREAD: '',
  GPUIX_BACKGROUND: '1', KYBERN_MEMORY_COUNTERS: '1', KYBERN_APPEARANCE: 'dark', KYBERN_PACING_IGNORE_PHYSICAL_MOUSE: '1', KYBERN_MEMORY_LOG_MS: '5000',
})
const rows: Record<string, unknown>[] = []
try {
  await f.app.getByTestId('app-ready').waitFor()
  const port = (name: string) => JSON.parse(readFileSync(path.join(client, `${name}-control.json`), 'utf8')).port as number
  for (const until = Date.now() + 20000; ; await Bun.sleep(50)) { try { port('memlog'); break } catch { assert(Date.now() < until) } }
  const call = async (name: string, action: string, args: Record<string, unknown> = {}) => {
    const res = await fetch(`http://127.0.0.1:${port(name)}`, { method: 'POST', body: JSON.stringify({ action, ...args }) })
    if (!res.ok) throw Error(await res.text())
    return res.json() as Promise<Record<string, any>>
  }
  const bench = (action: string, args?: Record<string, unknown>) => call('bench', action, args)
  const memlog = (action: string, args?: Record<string, unknown>) => call('memlog', action, args)
  const sample = async (name: string, census = false) => {
    const text = execFileSync('footprint', ['-p', String(f.pid)], { encoding: 'utf8' })
    const size = (re: RegExp) => { const m = text.match(re); return m ? Math.round(Number(m[1]) * (m[2] === 'GB' ? 1024 : m[2] === 'KB' ? 1 / 1024 : m[2] === 'B' ? 1 / 1048576 : 1)) : null }
    const category = (c: string) => size(new RegExp(`^\\s*([\\d.]+) (B|KB|MB|GB)\\s+[\\d.]+ \\w+\\s+[\\d.]+ \\w+\\s+\\d+\\s+${c.replace(/[()]/g, '\\$&')}$`, 'm'))
    const stats = await call('memory', 'stats')
    const row: Record<string, unknown> = {
      name, footprintMB: size(/phys_footprint:\s+([\d.]+) (\w+)/), peakMB: size(/phys_footprint_peak:\s+([\d.]+) (\w+)/),
      jsTagMB: category('App-Specific Tag 1'), ioSurfaceMB: category('IOSurface'), ioAccelMB: category('IOAccelerator'), gfxMB: category('IOAccelerator (graphics)'), untaggedMB: category('Untagged'), mallocSmallMB: category('Malloc Small'),
      heapMB: Math.round(stats.heap.heapSize / 1048576), extraMB: Math.round(stats.heap.extraMemorySize / 1048576), largeMB: Math.round((stats.native?.largeAllocations?.currentBytes ?? 0) / 1048576),
      images: stats.native?.images,
    }
    if (census) { const c = await memlog('census'); row.liveHeapMB = Math.round(c.heapSize / 1048576); row.liveExtraMB = Math.round(c.extra / 1048576); row.types = c.types }
    rows.push(row)
    writeFileSync(path.join(out, 'results.json'), JSON.stringify(rows, null, 2))
    const { types: _, images: __, ...brief } = row
    console.log(JSON.stringify(brief))
  }
  while (!(await bench('state')).listsLoaded) await Bun.sleep(50)
  await bench('home'); await Bun.sleep(5000)
  await sample('home', true)
  // Switching between threads, scrolling a little way up in each.
  for (const [i, thread] of threads.entries()) {
    await bench('open', { thread }); await Bun.sleep(1500)
    await memlog('earlier', { pages: 3 }); await Bun.sleep(500)
    if (i % 4 === 3) await sample(`threads-${i + 1}`)
  }
  // The orchestrator streaming live.
  let status = await memlog('replay', { thread: stream, perFrame: 6 })
  while (!status.done) { await Bun.sleep(500); status = await memlog('status') }
  await Bun.sleep(2000)
  await sample('streamed', true)
  // Documents beside the chat: code, Markdown, the diff and an image, each a tab.
  for (const file of ['apps/gpuix/src/Composer.tsx', 'apps/gpuix/native/README.md', 'apps/gpuix/src/Transcript.tsx', 'docs/architecture.md']) { await memlog('tab', { tab: { kind: 'file', path: file, root: 'project' } }); await Bun.sleep(1200) }
  await memlog('tab', { tab: { kind: 'diff' } }); await Bun.sleep(1500)
  await memlog('tab', { tab: { kind: 'image', source: '.kybern-artifacts/ade-54-58/L3/documents-dark.png', label: 'Image' } }); await Bun.sleep(1500)
  await sample('tabs', true)
  await bench('home'); await Bun.sleep(5000)
  await sample('home-after', true)
  await Bun.sleep(Number(process.env.KYBERN_SESSION_IDLE_MS ?? 60000))
  await sample('home-idle', true)
  if (process.env.KYBERN_SESSION_SNAPSHOT === '1') { await memlog('snapshot', { file: path.join(out, 'heap.json') }); console.log('snapshot', path.join(out, 'heap.json')) }
} finally {
  await f.close()
}
