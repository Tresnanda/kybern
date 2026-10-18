/** Full-product round trips, one <5 minute UI lease per independent process. */
import assert from 'node:assert/strict'
import { metadata } from './metadata.ts'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { seed } from '../bench/seed.ts'
import { actionFixture } from '../../src/pulls/verify.fixture.ts'
import { launchFixture } from '../../src/requests/harness.ts'
import { lease } from './lease.ts'
import { watchRun } from '../bench/process-gate.ts'
import { Telemetry, parseResources } from '../bench/telemetry.ts'
import { drive } from '../bench/input.ts'
import { requireActiveSample } from '../bench/screen-state.ts'
import { imageThread } from '../images/thread-fixture.ts'
import { onExit } from '../bench/lifetime.ts'
const label = process.argv[2] ?? 'diagnose'
const data = process.env.KYBERN_DATA_DIR!
const addon = process.env.NAPI_RS_NATIVE_LIBRARY_PATH ?? path.resolve(import.meta.dir, '../../native/build', label.startsWith('before') ? 'memory-before.node' : 'gpuix-native.darwin-arm64.node')
const out = `${process.env.KYBERN_MEMORY_EVIDENCE ?? '/Users/mymac/projects/ade/previews/gpuix/perf/memory'}/${label}-app`
mkdirSync(out, { recursive: true })
metadata(out, addon)
const fixture = await seed(data, Number(process.env.KYBERN_BENCH_PORT ?? '4332'))
const rows: unknown[] = []
try {
 if (process.env.KYBERN_MEMORY_IMAGE_THREAD === '1') await imageThread(fixture)
 const note = await fixture.client.call('notes.create', { scope: 'project', project_id: fixture.manifest.projects[0], title: 'Memory image note', body: '# Image residency\n\n' + Array.from({ length: 24 }, (_, i) => `![Fixture ${i}](${path.join(data, 'memory-images', `${i}.png`)})\n\n`).join('') })
 for (const group of process.env.KYBERN_MEMORY_GROUPS?.split(',') ?? ['thread-explorer-notes', 'terminal-stream', 'pull-request', 'webviews']) {
  const release = await lease(), leave = onExit(release)
  const proxy = group === 'pull-request' ? actionFixture({ long: true }) : null
  let previewServer: ReturnType<typeof Bun.serve> | null = null
  const webkitProcesses = () => execFileSync('ps', ['-Ao', 'pid=,comm='], { encoding: 'utf8' }).split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/)
    return match && /com\.apple\.WebKit\.(?:WebContent|GPU|Networking)/.test(match[2]!) ? [{ pid: Number(match[1]), command: match[2]! }] : []
  })
  const preexistingWebkit = new Set(webkitProcesses().map(process => process.pid))
  const client = path.join(data, `memory-${label}-${group}`); mkdirSync(client, { recursive: true })
  const telemetry = new Telemetry()
  const f = await launchFixture(path.join(import.meta.dir, 'app.ts'), { ...fixture.env, ...proxy?.env, NAPI_RS_NATIVE_LIBRARY_PATH: addon, KYBERN_CLIENT_CONFIG_DIR: client, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(client, 'credentials'), KYBERN_BENCH_WHEEL_LIBRARY: path.join(data, 'bench-wheel.dylib'), KYBERN_GPUIX_THREAD: '', GPUIX_BACKGROUND: '1', KYBERN_FULL_RATE: '1', KYBERN_MEMORY_COUNTERS: '1', KYBERN_FRAME_TIMES: '1', KYBERN_FRAME_COSTS: '1', KYBERN_PACING_IGNORE_PHYSICAL_MOUSE: '1', KYBERN_APPEARANCE: process.env.KYBERN_APPEARANCE ?? 'dark' }, { stderr: telemetry.stderr })
  const stop = onExit(async () => { await f.close(); proxy?.close(); await previewServer?.stop(true) })
  const timeout = setTimeout(() => process.kill(process.pid, 'SIGTERM'), 250000)
  try {
   await f.app.getByTestId('app-ready').waitFor()
   const port = (file: string) => JSON.parse(readFileSync(path.join(client, `${file}-control.json`), 'utf8')).port as number
   const deadline = Date.now() + 20000
   while (true) { try { port('memory'); break } catch { assert(Date.now() < deadline); await Bun.sleep(50) } }
   const control = async (action: string, args: Record<string, unknown> = {}, memory = false) => {
    const res = await fetch(`http://127.0.0.1:${port(memory ? 'memory' : 'bench')}`, { method: 'POST', body: JSON.stringify({ action, ...args }) })
    if (!res.ok) throw Error(await res.text())
    return res.json()
   }
   const bounds = async (id: string) => {
    const until = Date.now() + 30000
    while (true) {
     try { const b = await f.app.getByTestId(id).bounds(); if (b.width > 0 && b.height > 0) return b } catch { /* Await native layout. */ }
     assert(Date.now() < until, `No painted bounds: ${id}`); await Bun.sleep(50)
    }
   }
   const measure = async (name: string, warmup = true, scroll?: { x: number; y: number }) => {
    if (process.env.KYBERN_MEMORY_SMOKE === '1') {
      await Bun.sleep(name === 'mermaid-jobs-every-3s' ? 8000 : 1000)
      const state = await control('stats', {}, true) as { diagrams: { completed: number } }
      if (name === 'mermaid-jobs-every-3s') assert(state.diagrams.completed >= 1, 'Smoke must actually render Mermaid')
      console.log('smoke', name, JSON.stringify({ diagrams: state.diagrams, preview: (state as { preview?: unknown }).preview }))
      return
    }
    await f.app.call('blur', {}); await f.app.mouse.move({ x: 900, y: 4 })
    if (warmup) { if (scroll) await drive(f.app, scroll, 10000); else await Bun.sleep(10000) }
    await f.app.call('blur', {})
    const gate = watchRun(), mark = telemetry.mark()
    const webkit = webkitProcesses().filter(process => !preexistingWebkit.has(process.pid))
    const sampler = Bun.spawn(['bun', path.join(import.meta.dir, '../sample.ts'), '15', `GPUIX=${f.pid}`], { stdout: 'pipe', stderr: 'pipe' })
    const cancel = onExit(async () => { sampler.kill(); await sampler.exited })
    const webSampler = webkit.length ? Bun.spawn(['bun', path.join(import.meta.dir, '../sample.ts'), '15', `WebKit=${webkit.map(process => process.pid).join(',')}`], { stdout: 'pipe', stderr: 'pipe' }) : null
    const webText = webSampler ? new Response(webSampler.stdout).text() : Promise.resolve('')
    const webError = webSampler ? new Response(webSampler.stderr).text() : Promise.resolve('')
    const cancelWeb = onExit(async () => { webSampler?.kill(); await webSampler?.exited })
    const offered = scroll ? drive(f.app, scroll, 15000) : Promise.resolve(null)
    const raw = await new Response(sampler.stdout).text(); assert.equal(await sampler.exited, 0); cancel()
    const webkitRaw = await webText, webkitError = await webError
    const webkitExit = webSampler ? await webSampler.exited : 0; cancelWeb()
    const input = await offered
    const timing = telemetry.result(mark), overlap = gate.finish()
    if (scroll) requireActiveSample(timing.frames.count, parseResources(raw).gpuMs, 15)
    const prefix = `${group}-${name}`
    writeFileSync(path.join(out, `${prefix}-footprint.txt`), execFileSync('footprint', ['-p', String(f.pid)], { encoding: 'utf8' }))
    writeFileSync(path.join(out, `${prefix}-vmmap.txt`), execFileSync('vmmap', ['-summary', String(f.pid)], { encoding: 'utf8' }))
    for (const process of webkit) {
      try { writeFileSync(path.join(out, `${prefix}-webkit-${process.pid}-footprint.txt`), execFileSync('footprint', ['-p', String(process.pid)], { encoding: 'utf8' })) } catch { /* An XPC service may exit after sampling. */ }
    }
    const attribution = await control('stats', {}, true) as { diagrams: { completed: number; failed: number } }
    if (name === 'mermaid-jobs-every-3s') assert(attribution.diagrams.completed >= 1, 'Mermaid must actually render')
    rows.push({ group, name, input, fullRate: '1', ...timing, resources: parseResources(raw), webkitResources: webkitRaw && !webkitExit ? parseResources(webkitRaw) : null, webkitSampleError: webkitExit ? webkitError : null, webkitCandidates: webkit, webkitAttribution: 'New WebKit XPC services during this isolated fixture lease; external app launches can confound attribution. Main GPUIX resources remain separate.', attribution, counters: await control('counters'), gate: overlap })
    writeFileSync(path.join(out, 'results.json'), JSON.stringify(rows, null, 2))
    assert(!overlap.overlap && !overlap.orphanOverlap && !overlap.screenInvalid, 'Contended sample must be rerun')
   }
   // Keep the synthetic running sidebar row for matched active-screen samples.
   // The separate idle-home benchmark removes it after lists hydrate.
   while (!(await control('state') as { listsLoaded: boolean }).listsLoaded) await Bun.sleep(50)
   await control('home'); await measure('home-initial')
   if (group === 'image-thread') {
    await control('open', { thread: fixture.manifest.long1000 })
    await f.app.getByTestId('response-image').waitFor({ timeoutMs: 30000 })
    const viewport = await bounds('transcript-surface')
    await measure('image-thread-scroll', true, { x: viewport.x + viewport.width / 2, y: viewport.y + viewport.height / 2 })
   } else if (group === 'thread-explorer-notes') {
    await control('open', { thread: fixture.manifest.long3000 })
    const history = await control('older-all', {}, true) as { blocks: number; nextBeforeSeq: number | null }
    assert(history.nextBeforeSeq == null && history.blocks >= 6000, 'All 3000 turns must be reachable')
    for (let i = 0; i < 3000; i += 20) { await control('jump', { index: i }, true); await Bun.sleep(80) }
    await measure('thread-3000')
    await control('home'); await control('open', { thread: fixture.manifest.long3000 })
    await control('explorer', { file: fixture.manifest.markdown }); await Bun.sleep(1500)
    await control('explorer', { file: fixture.manifest.code }); await measure('explorer-code')
    await control('dock-close'); await control('note', { note: note.id }, true); await measure('note-images')
   } else if (group === 'terminal-stream') {
    await control('open', { thread: fixture.manifest.long1000 }); await control('terminal', {}, true)
    await f.app.getByTestId('terminal-screen').waitFor({ timeoutMs: 30000 })
    const terminals = await fixture.client.call('terminals.list', { thread_id: fixture.manifest.long1000 })
    const terminal = terminals.terminals.at(-1)!
    await fixture.client.call('terminals.input', { terminal_id: terminal.id, data: Buffer.from("python3 -c 'for i in range(12000): print(str(i)+\": Terminal scrollback 🌿\")'\r").toString('base64') })
    await measure('terminal-scrollback')
    await control('dock-close'); await control('open', { thread: fixture.manifest.running }); await control('stream', { durationMs: 27000 }); await measure('streaming')
    await fixture.client.call('terminals.close', { terminal_id: terminal.id })
   } else if (group === 'pull-request') {
    for (const id of ['rail-pulls', 'pr-row-108', 'pr-tab-changes']) { const b = await bounds(id); await f.app.mouse.click({ x: b.x + b.width / 2, y: b.y + b.height / 2 }) }
    const b = await bounds('pr-native-diff')
    for (let n = 0; n < 20; n++) await f.app.call('scrollWheel', { x: b.x + b.width / 2, y: b.y + b.height / 2, deltaY: -400, deltaX: 0 })
    await measure('changes-2400')
   } else if (group === 'webviews') {
    await control('open', { thread: fixture.manifest.long1000 })
    const html = '<!doctype html><meta charset="utf-8"><title>Memory preview</title><h1>Memory preview</h1><img src="fixture.png">' + Array.from({ length: 2000 }, (_, i) => `<p>Preview row ${i}</p>`).join('')
    // Daemon-data folders deliberately cannot be granted to file previews.
    // Exercise the real server-preview path with an owned loopback origin.
    previewServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      return new URL(request.url).pathname === '/fixture.png'
        ? new Response(Bun.file(path.join(fixture.manifest.projectPath, 'fixture.png')))
        : new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    } })
    await control('preview', { file: `http://127.0.0.1:${previewServer.port}/` }, true); await bounds('preview-slot-dock')
    const previewDeadline = Date.now() + 30000
    while (true) {
      const state = await control('stats', {}, true) as { preview: { phase: string; loading: boolean } | null }
      assert(state.preview?.phase === 'ready', 'Preview must show the actual document')
      if (!state.preview.loading) break
      assert(Date.now() < previewDeadline, 'Preview did not load'); await Bun.sleep(100)
    }
    await measure('preview-open')
    await control('preview-close', {}, true); await control('dock-close'); await control('home'); await measure('preview-closed')
    await control('mermaid-start', {}, true); await measure('mermaid-jobs-every-3s')
    await control('mermaid-stop', {}, true)
    if (process.env.KYBERN_MEMORY_SMOKE === '1') await Bun.sleep(12000)
    await Bun.sleep(1500) // Last job plus the existing ten-second idle release.
   }
   await control('home'); await measure('home-returned')
  } finally {
   clearTimeout(timeout); writeFileSync(path.join(out, `${group}-native.log`), telemetry.raw)
   await f.close(); proxy?.close(); await previewServer?.stop(true); stop(); release(); leave()
  }
 }
} finally { await fixture.close() }
