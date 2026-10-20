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
import { drive } from '../bench/input.ts'
import { requireActiveSample } from '../bench/screen-state.ts'
import { distribution } from '../bench/model.ts'
import { Telemetry, parseResources } from '../bench/telemetry.ts'
import { onExit } from '../bench/lifetime.ts'
import { assertTestDisplayWindow } from '../images/onscreen.ts'
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
const sceneTransitions: { kind: string; readyMs: number }[] = []
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
  if (process.env.KYBERN_MEMORY_REQUIRE_VM === '1') {
    const stats = await control({ action: 'stats' }) as { native?: { largeAllocations?: { enabled: boolean; thresholdBytes: number }; dispatchFrames?: number[]; smallAllocator?: { enabled: boolean; postFrameEnabled: boolean; frameCollections: number } } }
    assert.equal(stats.native?.largeAllocations?.thresholdBytes, (process.env.KYBERN_CODE_MEMORY === '0' ? 4 * 1024 * 1024 : 64 * 1024), 'Rebuild the VM allocator addon before sampling')
    assert.equal(stats.native?.largeAllocations?.enabled, process.env.KYBERN_LARGE_ALLOCATIONS_VM !== '0', 'Allocator control must match the process launch environment')
    if (process.env.KYBERN_MEMORY_REQUIRE_CODE_FRAMES === '1') assert.equal(stats.native?.dispatchFrames?.length, 3, 'Rebuild the dispatch-buffer capacity addon before sampling')
    if (process.env.KYBERN_MEMORY_REQUIRE_SMALL === '1') assert.equal(stats.native?.smallAllocator?.enabled, process.env.KYBERN_CODE_MEMORY !== '0' && process.env.KYBERN_CODE_SMALL_MEMORY !== '0', 'Rebuild the Rust small-allocator addon before sampling')
    if (process.env.KYBERN_MEMORY_REQUIRE_POST === '1') {
      assert.equal(stats.native?.smallAllocator?.postFrameEnabled, process.env.KYBERN_CODE_POST_FRAME_MEMORY !== '0')
      assert.equal(typeof stats.native?.smallAllocator?.frameCollections, 'number', 'Rebuild the frame-completion collector addon before sampling')
    }
  }
  const scene = async (kind: string, index = 0, peer = false) => {
    const at = performance.now()
    await control({ action: 'scene', kind, index, peer }); if (!kind.startsWith('code')) await Bun.sleep(120)
    const deadline = Date.now() + 20000
    if (kind.startsWith('code')) {
      const id = kind === 'code-virtual' ? 'dock-code-chunk-0' : 'memory-code'
      while (true) {
        try { const bounds = await f.app.getByTestId(id).bounds(); if (bounds.width > 0 && bounds.height > 0) break } catch {}
        assert(Date.now() < deadline, `Code did not paint: ${kind}`); await Bun.sleep(20)
      }
    }
    const next = telemetry.submissions.find(frame => frame.received >= at)
    if (next) sceneLatency.push(next.received - at)
    sceneTransitions.push({ kind, readyMs: performance.now() - at })
  }
  const measure = async (name: string, scroll?: { x: number; y: number }) => {
    await f.app.call('blur', {})
    if (['perf-images', 'hr5-memory'].includes(process.env.KYBERN_MEMORY_LANE ?? '')) await assertTestDisplayWindow(f.pid)
    if (scroll) await drive(f.app, scroll, 10000); else await Bun.sleep(10000)
    const testDisplayBefore = ['perf-images', 'hr5-memory'].includes(process.env.KYBERN_MEMORY_LANE ?? '') ? await assertTestDisplayWindow(f.pid) : null
    const gate = watchRun(), mark = telemetry.mark()
    const sample = Bun.spawn(['bun', path.join(import.meta.dir, '../sample.ts'), '15', `GPUIX=${f.pid}`], { stdout: 'pipe', stderr: 'pipe' })
    const cancel = onExit(async () => { sample.kill(); await sample.exited })
    const offered = scroll ? drive(f.app, scroll, 15000) : Promise.resolve(null)
    const raw = await new Response(sample.stdout).text(); assert.equal(await sample.exited, 0); cancel()
    const input = await offered
    const timing = telemetry.result(mark, input?.sent ?? []), overlap = gate.finish()
    if (scroll) requireActiveSample(timing.frames.count, parseResources(raw).gpuMs, 15)
    const testDisplayAfter = ['perf-images', 'hr5-memory'].includes(process.env.KYBERN_MEMORY_LANE ?? '') ? await assertTestDisplayWindow(f.pid) : null
    const footprint = execFileSync('footprint', ['-p', String(f.pid)], { encoding: 'utf8' })
    const vmmap = execFileSync('vmmap', ['-summary', String(f.pid)], { encoding: 'utf8' })
    writeFileSync(path.join(out, `${name}-footprint.txt`), footprint)
    writeFileSync(path.join(out, `${name}-vmmap.txt`), vmmap)
    writeFileSync(path.join(out, `${name}-resources.txt`), raw)
    const attribution = await control({ action: 'stats' })
    if (process.env.KYBERN_MEMORY_REQUIRE_VM === '1') {
      assert.equal(attribution.native.largeAllocations.mapFailures, 0, 'No failed native mappings')
      assert.equal(attribution.native.largeAllocations.unmapFailures, 0, 'No failed native releases')
      if (name.startsWith('home') && process.env.KYBERN_MEMORY_REQUIRE_CODE_FRAMES === '1' && process.env.KYBERN_CODE_MEMORY !== '0' && process.env.KYBERN_CODE_FRAME_MEMORY !== '0') assert(attribution.native.dispatchFrames[1] + attribution.native.dispatchFrames[2] < 1024 * 1024, 'Closed code returns its spare dispatch buffers')
    }
    rows.push({ name, input, testDisplayBefore, testDisplayAfter, sceneSubmissionProxyMs: distribution(sceneLatency), sceneSubmissionSamples: sceneLatency.length, fullRate: '1', ...timing, resources: parseResources(raw), attribution, gate: overlap })
    writeFileSync(path.join(out, 'results.json'), JSON.stringify(rows, null, 2))
    writeFileSync(path.join(out, 'scene-transitions.json'), JSON.stringify(sceneTransitions, null, 2))
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
  assert(Number.isInteger(repeats) && repeats >= 0 && repeats <= 3, 'At most three code round trips per lease')
  for (let round = 0; round < repeats; round++) {
    const suffix = round > 1 ? `-repeat-${round}` : round ? '-repeat' : ''
    await scene(process.env.KYBERN_MEMORY_CODE_KIND ?? 'code'); await measure(`code-12000${suffix}`)
    if (process.env.KYBERN_MEMORY_CODE_KIND === 'code-virtual' && process.env.KYBERN_MEMORY_CODE_SCROLL !== '0') {
      const bounds = await f.app.getByTestId('dock-file-content').bounds()
      await measure(`code-scroll${suffix}`, { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 })
    }
    await scene('home'); await measure(`home-code${suffix}`)
  }
  const heapFile = path.join(out, process.env.KYBERN_MEMORY_EDITOR_MANY === '1' ? 'home-editor-many-heap.txt' : 'home-code-heap.txt')
  if (process.env.KYBERN_MEMORY_HEAP === '1' || process.env.KYBERN_MEMORY_STACKS === '1') {
    writeFileSync(heapFile, execFileSync('heap', ['-s', '-H', String(f.pid)], { encoding: 'utf8' }))
  }
  if (process.env.KYBERN_MEMORY_STACKS === '1') {
    const diagnose = (file: string, program: string, args: string[]) => {
      let output: string
      try { output = execFileSync(program, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 15000 }) }
      catch (error) { const failure = error as Error & { stderr?: Buffer }; output = `${failure.message}\n${failure.stderr?.toString() ?? ''}` }
      writeFileSync(path.join(out, file), output)
      return output
    }
    // Stack logging adds allocator bookkeeping (6,144 KiB became 6,160 KiB
    // on the measured host). Match the reported size rather than pixel bytes.
    const histogram = readFileSync(heapFile, 'utf8')
    const reportedKiB = histogram.match(/Sizes:\s*(\d+)KB\[/)?.[1]
    assert(reportedKiB, 'Heap must report its largest allocation size')
    const decodedBlocks = [...histogram.matchAll(/\b(?:6144|6160)KB\[(\d+)\]/g)].reduce((sum, match) => sum + Number(match[1]), 0)
    writeFileSync(path.join(out, 'decoded-image-blocks.json'), JSON.stringify({
      fixture: '24 images; retained blocks were 6144 KiB or 6160 KiB with stack logging', decodedBlocks, largestAllocationKiB: Number(reportedKiB),
    }, null, 2))
    // After the fix there is no image-sized live block. Tracing the largest
    // unrelated font allocation adds no image ownership evidence.
    if (decodedBlocks > 0) {
      const pattern = `malloc[${Number(reportedKiB) * 1024}]`
      const exact = diagnose('large-allocation-addresses-exact.txt', 'heap', ['--noContent', `--addresses=${pattern}`, String(f.pid)])
      // Derived non-object names may not match the literal malloc class filter,
      // even when its size matches the histogram. Sort all live blocks instead.
      const addresses = /^\s*0x[0-9a-f]+\b/im.test(exact) ? exact : diagnose('large-allocation-addresses.txt', 'heap', ['-s', '-H', '--noContent', '--addresses=all', String(f.pid)])
      const pointer = addresses.split('\n').flatMap(line => line.match(/^\s*(0x[0-9a-f]+)\b/i)?.[1] ?? [])[0]
      if (pointer) {
        diagnose('large-allocation-calltree.txt', 'malloc_history', [String(f.pid), '-callTree', '-noContent', pointer])
        diagnose('large-allocation-history-0.txt', 'malloc_history', [String(f.pid), '-fullStacks', pointer])
        diagnose('large-allocation-owners-0.txt', 'leaks', ['--noContent', '--fullStacks', `--traceTree=${pointer}`, String(f.pid)])
        diagnose('large-allocation-root-paths-0.txt', 'leaks', ['--noContent', '--conservative', `--trace=${pointer}`, String(f.pid)])
      }
    }
  }
  // Run this only after ownership traces and all original resource samples.
  // It distinguishes live image retention from freed malloc cache pages.
  if (process.env.KYBERN_MEMORY_RELIEF === '1' || process.env.KYBERN_MEMORY_STACKS === '1') {
    writeFileSync(path.join(out, 'allocator-relief.json'), JSON.stringify(await control({ action: 'allocator-relief' }), null, 2))
    await measure('home-relief')
  }
} finally {
  clearTimeout(watchdog)
  writeFileSync(path.join(out, 'native.log'), telemetry.raw)
  await f.close(); stop(); release(); leave()
}

