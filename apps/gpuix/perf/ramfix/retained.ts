/**
 * Memory kept after use. One scratch window on the hidden test display:
 * Home → a 3,000-turn thread (all history, visited every 25 turns) → a
 * 1,000-turn thread whose newest 48 turns carry distinct 1536×1024 images →
 * Explorer Markdown and a 12,000-line code file (closed again) → a note with
 * 24 distinct 1536×1024 images → Home. Samples footprint, vmmap and native
 * counters at Home before, right after the workload and after two idle
 * minutes; records the footprint peak and reopen times for the code file,
 * the long thread and the image note.
 *
 *   KYBERN_DATA_DIR=/Users/mymac/projects/ade-gpuix-scratch/motion-ramfix \
 *   KYBERN_BENCH_PORT=4386 bun perf/ramfix/retained.ts <label>
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { seed } from '../bench/seed.ts'
import { launchFixture } from '../../src/requests/harness.ts'
import { onExit } from '../bench/lifetime.ts'
import { lease } from '../memory/lease.ts'
import { imageThread } from '../images/thread-fixture.ts'
import { assertTestDisplayWindow } from '../images/onscreen.ts'
import { gradientPng } from '../../visual/fixture.ts'
import { nativeBuildMarkers, quietMarkers } from '../bench/build-overlap.ts'
import { loadavg } from 'node:os'

const label = process.argv[2] ?? 'diagnose'
const idleMs = Number(process.env.KYBERN_RAMFIX_IDLE_MS ?? 120000)
const data = process.env.KYBERN_DATA_DIR!
assert(data?.includes('scratch'), 'Explicit scratch data directory required')
const addon = process.env.KYBERN_RAMFIX_ADDON ?? path.resolve(import.meta.dir, '../../native/build/gpuix-native.darwin-arm64.node')
const out = path.join(process.env.KYBERN_RAMFIX_EVIDENCE ?? '/Users/mymac/projects/ade/previews/motion/ramfix', `retained-${label}`)
mkdirSync(out, { recursive: true })

const fixture = await seed(data, Number(process.env.KYBERN_BENCH_PORT ?? '4386'))
const dropFixture = onExit(() => fixture.close())
if (!existsSync(path.join(data, 'image-thread-fixture.json'))) await imageThread(fixture)
const images = path.join(data, 'ramfix-images'); mkdirSync(images, { recursive: true })
if (!existsSync(path.join(images, '23.png'))) for (let i = 0; i < 24; i++) writeFileSync(path.join(images, `${i}.png`), gradientPng(1536 + i, 1024))
const bigCode = path.join(fixture.manifest.projectPath, 'big.ts')
if (!existsSync(bigCode)) writeFileSync(bigCode, Array.from({ length: 12000 }, (_, i) => `export function handler${i}(input: { id: number; title: string }) { return { ...input, index: ${i}, label: \`row \${input.title}\` } }`).join('\n'))
const note = await fixture.client.call('notes.create', { scope: 'project', project_id: fixture.manifest.projects[0], title: `Ramfix images ${label}`, body: '# Image residency\n\n' + Array.from({ length: 24 }, (_, i) => `![Image ${i}](${path.join(images, `${i}.png`)})\n\n`).join('') }) as { id: string }

const release = await lease()
const leave = onExit(release)
const client = path.join(data, `ramfix-retained-${label}`); mkdirSync(client, { recursive: true })
const f = await launchFixture(path.join(import.meta.dir, 'app.ts'), {
  ...fixture.env, NAPI_RS_NATIVE_LIBRARY_PATH: addon, KYBERN_GPUIX_RESOURCES: '', KYBERND: '', KYBERN_BUNDLED_CLI: '',
  KYBERN_CLIENT_CONFIG_DIR: client, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(client, 'credentials'), KYBERN_GPUIX_THREAD: '',
  GPUIX_BACKGROUND: '1', KYBERN_MEMORY_COUNTERS: '1', KYBERN_APPEARANCE: 'dark', KYBERN_PACING_IGNORE_PHYSICAL_MOUSE: '1',
}).catch(async error => { release(); await fixture.close(); throw error })
dropFixture()
const stop = onExit(async () => { await f.close(); await fixture.close(); release() })
const watchdog = setTimeout(() => process.kill(process.pid, 'SIGTERM'), 295000)
const rows: Record<string, unknown>[] = []
try {
  await f.app.getByTestId('app-ready').waitFor()
  const port = (name: string) => JSON.parse(readFileSync(path.join(client, `${name}-control.json`), 'utf8')).port as number
  const until = Date.now() + 20000
  while (true) { try { port('memory'); break } catch { assert(Date.now() < until); await Bun.sleep(50) } }
  const control = async (action: string, args: Record<string, unknown> = {}, memory = false) => {
    const res = await fetch(`http://127.0.0.1:${port(memory ? 'memory' : 'bench')}`, { method: 'POST', body: JSON.stringify({ action, ...args }) })
    if (!res.ok) throw Error(await res.text())
    return res.json() as Promise<Record<string, any>>
  }
  const bounds = async (id: string, timeout = 30000) => {
    const deadline = Date.now() + timeout
    for (;;) {
      try { const b = await f.app.getByTestId(id).bounds(); if (b.width > 0 && b.height > 0) return b } catch { /* Await native layout. */ }
      assert(Date.now() < deadline, `No painted bounds: ${id}`); await Bun.sleep(25)
    }
  }
  const sample = async (name: string) => {
    const footprint = execFileSync('footprint', ['-p', String(f.pid)], { encoding: 'utf8' })
    writeFileSync(path.join(out, `${name}-footprint.txt`), footprint)
    writeFileSync(path.join(out, `${name}-vmmap.txt`), execFileSync('vmmap', ['-summary', String(f.pid)], { encoding: 'utf8', maxBuffer: 64 << 20 }))
    const mb = (re: RegExp) => { const m = footprint.match(re); return m ? Number(m[1]) * (m[2] === 'GB' ? 1024 : m[2] === 'KB' ? 1 / 1024 : 1) : null }
    const category = (name: string) => { const m = footprint.match(new RegExp(`^\\s*([\\d.]+) (B|KB|MB|GB)\\s+[\\d.]+ \\w+\\s+[\\d.]+ \\w+\\s+\\d+\\s+${name.replace(/[()]/g, '\\$&')}$`, 'm')); return m ? Number(m[1]) / (m[2] === 'KB' ? 1024 : m[2] === 'B' ? 1 << 20 : m[2] === 'GB' ? 1 / 1024 : 1) : 0 }
    const stats = await control('stats', {}, true)
    const row = {
      name, at: Date.now(), loadavg: loadavg().map(v => Math.round(v * 100) / 100), buildMarkers: nativeBuildMarkers(), quietMarkers: quietMarkers(),
      footprintMB: mb(/phys_footprint:\s+([\d.]+) (\w+)/), peakMB: mb(/phys_footprint_peak:\s+([\d.]+) (\w+)/),
      categoriesMB: Object.fromEntries(['App-Specific Tag 1', 'IOSurface', 'IOAccelerator', 'IOAccelerator (graphics)', 'Untagged', 'Malloc Small', 'Malloc Large', 'JS JIT Generated Code'].map(c => [c, Math.round(category(c) * 10) / 10])),
      heap: stats.heap ? { heapSize: stats.heap.heapSize, heapCapacity: stats.heap.heapCapacity, extraMemorySize: stats.heap.extraMemorySize, objectCount: stats.heap.objectCount } : null,
      process: stats.process, native: stats.native,
    }
    rows.push(row)
    writeFileSync(path.join(out, 'results.json'), JSON.stringify({ label, addon, idleMs, rows }, null, 2))
    console.log(name, row.footprintMB, 'MB peak', row.peakMB, JSON.stringify(row.categoriesMB))
  }
  const marks: Record<string, Record<string, number>> = {}
  const mark = (name: string) => {
    if (process.env.KYBERN_RAMFIX_STAGES !== '1') return
    const text = execFileSync('footprint', ['-p', String(f.pid)], { encoding: 'utf8' })
    const value = (c: string) => { const m = text.match(new RegExp(`^\\s*([\\d.]+) (B|KB|MB|GB)\\s+[\\d.]+ \\w+\\s+[\\d.]+ \\w+\\s+\\d+\\s+${c.replace(/[()]/g, '\\$&')}$`, 'm')); return m ? Math.round(Number(m[1]) / (m[2] === 'KB' ? 1024 : m[2] === 'B' ? 1 << 20 : m[2] === 'GB' ? 1 / 1024 : 1) * 10) / 10 : 0 }
    marks[name] = Object.fromEntries(['IOAccelerator', 'IOAccelerator (graphics)', 'App-Specific Tag 1', 'Untagged', 'Malloc Small'].map(c => [c, value(c)]))
    console.log('mark', name, JSON.stringify(marks[name]))
    writeFileSync(path.join(out, 'marks.json'), JSON.stringify(marks, null, 2))
  }
  while (!(await control('state')).listsLoaded) await Bun.sleep(50)
  await control('home'); await control('idle')
  await assertTestDisplayWindow(f.pid)
  await Bun.sleep(10000)
  await sample('home-initial')

  // Long text thread, every page of history, every 25 turns visited.
  await control('open', { thread: fixture.manifest.long3000 }); await bounds('transcript-surface')
  const history = await control('older-all', {}, true)
  assert(history.nextBeforeSeq == null && history.blocks >= 6000, 'All 3000 turns must be reachable')
  mark('long-thread-open')
  for (let i = 0; i < 3000; i += 25) { await control('jump', { index: i }, true); await Bun.sleep(40) }
  mark('long-thread-traversed')
  // Image thread: its newest 48 turns each carry a distinct large image.
  await control('open', { thread: fixture.manifest.long1000 }); await bounds('transcript-surface')
  await control('older-all', {}, true)
  for (let i = 940; i < 1000; i += 2) { await control('jump', { index: i }, true); await Bun.sleep(80) }
  mark('image-thread')
  // Explorer: long Markdown, then a 12,000-line code file, closed again.
  await control('explorer', { file: fixture.manifest.markdown }); await Bun.sleep(1500)
  mark('markdown')
  await control('explorer', { file: bigCode }); await bounds('dock-code-chunk-0')
  for (let i = 0; i < 6; i++) { const b = await bounds('dock-file-content'); await f.app.call('scrollWheel', { x: b.x + b.width / 2, y: b.y + b.height / 2, deltaY: -4000, deltaX: 0 }); await Bun.sleep(150) }
  mark('code')
  await f.app.getByTestId('dock-file-close').click(); await Bun.sleep(300)
  await control('dock-close')
  // A note with 24 distinct large images.
  await control('note', { note: note.id }, true)
  const imagesDeadline = Date.now() + 30000
  while (((await control('stats', {}, true)).native?.editorImages?.entries ?? 0) < 24) { assert(Date.now() < imagesDeadline, 'The note must decode all 24 images'); await Bun.sleep(100) }
  await Bun.sleep(1500)
  mark('image-note')
  await control('home')
  await Bun.sleep(5000)
  await sample('after-workload')
  // Where a real window would go to the background (`platform/idleMemory.ts`).
  let release: unknown = null
  if (process.env.KYBERN_RAMFIX_RELEASE === '1') {
    const ramfix = JSON.parse(readFileSync(path.join(client, 'ramfix-control.json'), 'utf8')).port as number
    release = await (await fetch(`http://127.0.0.1:${ramfix}`, { method: 'POST', body: JSON.stringify({ action: 'release' }) })).json()
    console.log('release', JSON.stringify(release))
    await Bun.sleep(2000)
    await sample('after-release')
  }
  await Bun.sleep(idleMs)
  await sample('after-idle')

  // Reopen: the first painted content after release.
  const reopen: Record<string, number> = {}
  let t = performance.now()
  await control('open', { thread: fixture.manifest.long3000 }); await bounds('transcript-surface')
  reopen.longThreadMs = performance.now() - t
  t = performance.now()
  await control('explorer', { file: bigCode }); await bounds('dock-code-chunk-0')
  reopen.codeFileMs = performance.now() - t
  await control('dock-close')
  t = performance.now()
  await control('note', { note: note.id }, true)
  while (((await control('stats', {}, true)).native?.editorImages?.entries ?? 0) < 24) { assert(performance.now() - t < 30000); await Bun.sleep(10) }
  reopen.imageNoteMs = performance.now() - t
  await control('home')
  await sample('after-reopen')
  writeFileSync(path.join(out, 'results.json'), JSON.stringify({ label, addon, idleMs, rows, reopen, release, meaning: 'Reopen = request to painted bounds / decoded image count through the automation RPC; not presentation' }, null, 2))
  console.log('reopen', JSON.stringify(reopen))
} finally { clearTimeout(watchdog); await f.close(); await fixture.close(); release(); stop(); leave() }
