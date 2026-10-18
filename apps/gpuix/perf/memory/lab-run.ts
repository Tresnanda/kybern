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
const stackDirectory = path.join(data, 'native-stack-logs')
if (process.env.KYBERN_MEMORY_STACKS === '1') mkdirSync(stackDirectory, { recursive: true })
const f = await launchFixture(path.join(import.meta.dir, 'lab.tsx'), { ...(process.env.KYBERN_MEMORY_STACKS === '1' ? { MallocStackLogging: '1', MallocStackLoggingNoCompact: '1', MallocStackLoggingDirectory: stackDirectory } : {}), NAPI_RS_NATIVE_LIBRARY_PATH: addon, KYBERN_DATA_DIR: data, KYBERN_CLIENT_CONFIG_DIR: client, KYBERN_URL: '', KYBERN_TOKEN: '', GPUIX_BACKGROUND: '1', KYBERN_FULL_RATE: '1', KYBERN_MEMORY_COUNTERS: '1', KYBERN_FRAME_TIMES: '1', KYBERN_FRAME_COSTS: '1', KYBERN_APPEARANCE: process.env.KYBERN_APPEARANCE ?? 'dark' }, { stderr: telemetry.stderr })
const stop = onExit(f.close)
const watchdog = setTimeout(() => process.kill(process.pid, 'SIGTERM'), 280000)
const rows: unknown[] = []
const sceneLatency: number[] = []
try {
  await f.app.getByTestId('app-ready').waitFor()
  if (process.env.KYBERN_MEMORY_REQUIRE_DETACH === '1') {
    // This mode is only for the archived, optional diagnostic patch.
    const renderer = JSON.parse(readFileSync(path.join(client, 'memory-control.json'), 'utf8')).port
    const state = await (await fetch(`http://127.0.0.1:${renderer}`, { method: 'POST', body: JSON.stringify({ action: 'stats' }) })).json() as { native?: { editorImages?: { detachedLayoutsCleared?: number } } }
    assert.equal(typeof state.native?.editorImages?.detachedLayoutsCleared, 'number', 'Apply the detached-layout diagnostic patch before running this experiment')
  }
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
    assert(!overlap.overlap && !overlap.orphanOverlap && !overlap.screenInvalid, 'Contended sample must be rerun')
  }
  await measure('home-initial')
  if (process.env.KYBERN_MEMORY_EDITOR_MANY === '1') {
    const rounds = Number(process.env.KYBERN_MEMORY_EDITOR_ROUNDS ?? '1')
    assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 3, 'At most three editable-note round trips per lease')
    for (let round = 0; round < rounds; round++) {
      await scene('editor-many')
      if (process.env.KYBERN_MEMORY_EDITOR_EDITABLE === '1') {
        const bounds = await f.app.getByTestId('memory-editor-many').bounds()
        await f.app.mouse.click({ x: bounds.x + 24, y: bounds.y + 12 })
      }
      await measure(round ? `editor-many-${round}` : 'editor-many')
      await scene('home'); await measure(round ? `home-editor-many-${round}` : 'home-editor-many')
    }
  }
  if (process.env.KYBERN_MEMORY_CODE_ONLY !== '1' && process.env.KYBERN_MEMORY_EDITOR_MANY !== '1') {
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 48; i++) await scene('image', i)
    await measure(`images-${round}`)
    await scene('home'); await measure(`home-images-${round}`)
  }
  for (let i = 0; i < 24; i++) await scene('editor', i)
  await measure('editor-images')
  await scene('home'); await measure('home-editor')
  }
  const repeats = process.env.KYBERN_MEMORY_EDITOR_MANY === '1' ? 0 : Number(process.env.KYBERN_MEMORY_CODE_ROUNDS ?? '1')
  assert(Number.isInteger(repeats) && repeats >= 0 && repeats <= 2, 'At most two code round trips per lease')
  for (let round = 0; round < repeats; round++) {
    await scene('code'); await measure(round ? 'code-12000-repeat' : 'code-12000')
    await scene('home'); await measure(round ? 'home-code-repeat' : 'home-code')
  }
  const heapFile = path.join(out, process.env.KYBERN_MEMORY_EDITOR_MANY === '1' ? 'home-editor-many-heap.txt' : 'home-code-heap.txt')
  if (process.env.KYBERN_MEMORY_HEAP === '1' || process.env.KYBERN_MEMORY_STACKS === '1') {
    writeFileSync(heapFile, execFileSync('heap', ['-s', '-H', String(f.pid)], { encoding: 'utf8' }))
  }
  if (process.env.KYBERN_MEMORY_STACKS === '1') {
    const diagnose = (file: string, program: string, args: string[]) => {
      let output: string
      try { output = execFileSync(program, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 15000 }) }
      catch (error) { const failure = error as Error & { stderr?: Buffer }; output = `${failure.message}\n${failure.stderr?.toString() ?? ''}` }
      writeFileSync(path.join(out, file), output)
      return output
    }
    // Stack logging adds allocator bookkeeping (6,144 KiB became 6,160 KiB
    // on the measured host). Match the reported size rather than pixel bytes.
    const histogram = readFileSync(heapFile, 'utf8')
    const reportedKiB = histogram.match(/Sizes:\s*(\d+)KB\[/)?.[1]
    assert(reportedKiB, 'Heap must report its largest allocation size')
    const pattern = `malloc[${Number(reportedKiB) * 1024}]`
    const addresses = diagnose('large-allocation-addresses.txt', 'heap', ['--noContent', `--addresses=${pattern}`, String(f.pid)])
    diagnose('large-allocation-calltree.txt', 'malloc_history', [String(f.pid), '-callTree', '-noContent', pattern])
    const pointer = addresses.split('\n').flatMap(line => line.match(/^\s*(0x[0-9a-f]+)\s/i)?.[1] ?? [])[0]
    if (pointer) {
      diagnose('large-allocation-history-0.txt', 'malloc_history', [String(f.pid), '-fullStacks', pointer])
      diagnose('large-allocation-owners-0.txt', 'leaks', ['--noContent', `--traceTree=${pointer}`, String(f.pid)])
    }
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
