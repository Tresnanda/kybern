/** Own-window image/native high-water diagnosis. Timed runs never capture. */
import assert from 'node:assert/strict'
import { metadata } from './metadata.ts'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { launchFixture } from '../../src/requests/harness.ts'
import { gradientPng } from '../../visual/fixture.ts'
import { lease } from './lease.ts'
import { watchRun } from '../bench/process-gate.ts'
import { distribution } from '../bench/model.ts'
import { Telemetry, parseResources } from '../bench/telemetry.ts'
import { onExit } from '../bench/lifetime.ts'
const label = process.argv[2] ?? 'diagnose'
const data = process.env.KYBERN_DATA_DIR!
const addon = process.env.NAPI_RS_NATIVE_LIBRARY_PATH ?? path.resolve(import.meta.dir, '../../native/build', label.startsWith('before') ? 'memory-before.node' : 'gpuix-native.darwin-arm64.node')
assert(data?.includes('scratch'), 'Explicit scratch data directory required')
const out = `${process.env.KYBERN_MEMORY_EVIDENCE ?? '/Users/mymac/projects/ade/previews/gpuix/perf/memory'}/${label}`
mkdirSync(out, { recursive: true })
metadata(out, addon)
const images = path.join(data, 'memory-images'); mkdirSync(images, { recursive: true })
if (!existsSync(path.join(images, '47.png'))) {
  const bytes = gradientPng(1536, 1024)
  for (let i = 0; i < 48; i++) writeFileSync(path.join(images, `${i}.png`), bytes)
}
const release = await lease()
const leave = onExit(release)
const client = path.join(data, `memory-client-${label}`); mkdirSync(client, { recursive: true })
const telemetry = new Telemetry()
const f = await launchFixture(path.join(import.meta.dir, 'lab.tsx'), { NAPI_RS_NATIVE_LIBRARY_PATH: addon, KYBERN_DATA_DIR: data, KYBERN_CLIENT_CONFIG_DIR: client, KYBERN_URL: '', KYBERN_TOKEN: '', GPUIX_BACKGROUND: '1', KYBERN_FULL_RATE: '1', KYBERN_MEMORY_COUNTERS: '1', KYBERN_FRAME_TIMES: '1', KYBERN_FRAME_COSTS: '1', KYBERN_APPEARANCE: process.env.KYBERN_APPEARANCE ?? 'dark' }, { stderr: telemetry.stderr })
const stop = onExit(f.close)
const watchdog = setTimeout(() => process.kill(process.pid, 'SIGTERM'), 280000)
const rows: unknown[] = []
const sceneLatency: number[] = []
try {
  await f.app.getByTestId('app-ready').waitFor()
  const port = JSON.parse(readFileSync(path.join(client, 'memory-control.json'), 'utf8')).port
  const control = async (body: Record<string, unknown>) => (await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: JSON.stringify(body) })).json()
  const scene = async (kind: string, index = 0, peer = false) => {
    const at = performance.now()
    await control({ action: 'scene', kind, index, peer }); await Bun.sleep(120)
    const next = telemetry.submissions.find(frame => frame.received >= at)
    if (next) sceneLatency.push(next.received - at)
  }
  const measure = async (name: string) => {
    await f.app.call('blur', {})
    await Bun.sleep(10000)
    const gate = watchRun(), mark = telemetry.mark()
    const sample = Bun.spawn(['bun', path.join(import.meta.dir, '../sample.ts'), '15', `GPUIX=${f.pid}`], { stdout: 'pipe', stderr: 'pipe' })
    const cancel = onExit(async () => { sample.kill(); await sample.exited })
    const raw = await new Response(sample.stdout).text(); assert.equal(await sample.exited, 0); cancel()
    const timing = telemetry.result(mark), overlap = gate.finish()
    const footprint = execFileSync('footprint', ['-p', String(f.pid)], { encoding: 'utf8' })
    const vmmap = execFileSync('vmmap', ['-summary', String(f.pid)], { encoding: 'utf8' })
    writeFileSync(path.join(out, `${name}-footprint.txt`), footprint)
    writeFileSync(path.join(out, `${name}-vmmap.txt`), vmmap)
    writeFileSync(path.join(out, `${name}-resources.txt`), raw)
    rows.push({ name, sceneSubmissionProxyMs: distribution(sceneLatency), sceneSubmissionSamples: sceneLatency.length, fullRate: '1', ...timing, resources: parseResources(raw), attribution: await control({ action: 'stats' }), gate: overlap })
    writeFileSync(path.join(out, 'results.json'), JSON.stringify(rows, null, 2))
    assert(!overlap.overlap && !overlap.orphanOverlap, 'Contended sample must be rerun')
  }
  await measure('home-initial')
  if (process.env.KYBERN_MEMORY_CODE_ONLY !== '1') {
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 48; i++) await scene('image', i)
    await measure(`images-${round}`)
    await scene('home'); await measure(`home-images-${round}`)
  }
  for (let i = 0; i < 24; i++) await scene('editor', i)
  await measure('editor-images')
  await scene('home'); await measure('home-editor')
  }
  const repeats = Number(process.env.KYBERN_MEMORY_CODE_ROUNDS ?? '1')
  assert(Number.isInteger(repeats) && repeats >= 1 && repeats <= 2, 'At most two code round trips per lease')
  for (let round = 0; round < repeats; round++) {
    await scene('code'); await measure(round ? 'code-12000-repeat' : 'code-12000')
    await scene('home'); await measure(round ? 'home-code-repeat' : 'home-code')
  }
  if (process.env.KYBERN_MEMORY_HEAP === '1') {
    writeFileSync(path.join(out, 'home-code-heap.txt'), execFileSync('heap', ['-s', '-H', String(f.pid)], { encoding: 'utf8' }))
  }
  if (process.env.KYBERN_MEMORY_RELIEF === '1') {
    writeFileSync(path.join(out, 'allocator-relief.json'), JSON.stringify(await control({ action: 'allocator-relief' }), null, 2))
    await measure('home-relief')
  }
} finally {
  clearTimeout(watchdog)
  writeFileSync(path.join(out, 'native.log'), telemetry.raw)
  await f.close(); stop(); release(); leave()
}
