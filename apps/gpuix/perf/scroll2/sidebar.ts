import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { connectStdio } from '@gpuix/react/automation'
import { assertScratchEnv } from '../../src/requests/harness.ts'
import { until } from '../../scripts/dock-waits.ts'

assertScratchEnv({ KYBERN_URL: '' })
const data = process.env.KYBERN_DATA_DIR!
const fixture = JSON.parse(readFileSync(path.join(data, 'fixture.json'), 'utf8')) as { threadId: string }
const out = process.env.SCROLL2_EVIDENCE ?? '/Users/mymac/projects/ade/previews/gpuix/perf/scroll2/sidebar'
mkdirSync(out, { recursive: true })
const label = process.argv[2] ?? 'baseline', theme = process.env.KYBERN_APPEARANCE ?? 'dark'
for (const name of (existsSync(process.env.KYBERN_CLIENT_CONFIG_DIR!) ? readdirSync(process.env.KYBERN_CLIENT_CONFIG_DIR!) : []).filter(name => /^workspace-.*\.json$/.test(name))) rmSync(path.join(process.env.KYBERN_CLIENT_CONFIG_DIR!, name))
const plan = path.join(data, `wheel-${process.pid}.json`)
// Saved selection wins over KYBERN_GPUIX_THREAD during boot. Every isolated
// run restores the same selected thread, dock width and initial geometry.
writeFileSync(path.join(data, 'gpuix-ui.json'), JSON.stringify({
  'kybern.dock.choices': [[fixture.threadId, { open: false, tabs: [], tab: null, width: 850 }]],
  'kybern.workspace.selected': { kind: 'thread', id: fixture.threadId },
  'kybern.split-view.v1': { version: 1, root: { kind: 'leaf', id: 'main', threadId: fixture.threadId }, focusedPaneId: 'main' },
}))
const child = spawn('bun', [path.join(import.meta.dir, 'app.ts')], { env: {
  ...process.env, ...(process.env.SIDEBAR_CHECKS !== '1' ? { KYBERN_OPAQUE: '1' } : {}), KYBERN_URL: '', KYBERN_GPUIX_THREAD: fixture.threadId,
  SIDEBAR_PLAN: plan, KYBERN_APPEARANCE: theme, KYBERN_WINDOW_SIZE: '1440x900',
  GPUIX_BACKGROUND: '1', KYBERN_FRAME_TIMES: '1', KYBERN_FRAME_COSTS: '1', KYBERN_FULL_RATE: '1',
  SIDEBAR_SOURCE: label.startsWith('baseline') ? 'baseline' : label.startsWith('p1') ? 'p1' : 'candidate',
}, stdio: ['pipe', 'pipe', 'pipe'] })
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => child.kill(signal))
const watchdog = setTimeout(() => { child.kill(); process.exit(124) }, 270_000)
let raw = '', pending = '', commits = 0
const frames: { native: number; received: number }[] = [], costs: { render: number; layout: number; calls: number }[] = []
const paints: { packets: number; first: number; last: number }[] = []
child.stderr.on('data', chunk => {
  raw += String(chunk); pending += String(chunk)
  const lines = pending.split('\n'); pending = lines.pop()!
  for (const line of lines) {
    const frame = line.match(/\[kybern-submit\] ([\d.]+)/)
    if (frame) frames.push({ native: Number(frame[1]), received: performance.now() })
    const work = line.match(/\[kybern-work\] renderMs=([\d.]+) layoutMs=([\d.]+) layoutCalls=(\d+)/)
    if (work) costs.push({ render: Number(work[1]), layout: Number(work[2]), calls: Number(work[3]) })
    const input = line.match(/\[scroll-input-paint\] packets=(\d+) firstMs=([\d.]+) lastMs=([\d.]+)/)
    if (input) paints.push({ packets: Number(input[1]), first: Number(input[2]), last: Number(input[3]) })
    if (line.includes('[sidebar-commit]')) commits++
  }
  if (process.env.SIDEBAR_DEBUG === '1') writeFileSync(`${out}/${label}-${theme}.live.log`, raw)
})
const pct = (values: number[], p: number) => [...values].sort((a,b) => a-b)[Math.min(values.length - 1, Math.floor(values.length * p))] ?? null
const buildMarkers = () => readdirSync('/tmp').filter(name => name.startsWith('kybern-gpuix-native-build.'))
const processCheck = (ownPid?: number) => {
  const listing = Bun.spawnSync(['pgrep', '-fl', 'bun .*ade-gpuix']).stdout.toString().trim()
  const others = listing.split('\n').filter(line => /^\d+\s+(?:\S*\/)?bun\s/.test(line) && Number(line.split(/\s+/)[0]) !== ownPid)
  if (others.length) throw Error(`Discard/repeat ${label}: other GPUIX processes alive: ${others.join('; ')}`)
  return listing
}
const observedBuildMarkers = new Set<string>()
const markerWatch = setInterval(() => { for (const marker of readdirSync('/tmp').filter(name => name.startsWith('kybern-gpuix-native-build.'))) observedBuildMarkers.add(marker) }, 250)
let app: Awaited<ReturnType<typeof connectStdio>> | undefined
const results: unknown[] = []
try {
  app = await Promise.race([
    connectStdio({ write: chunk => { child.stdin.write(chunk) }, feed: listener => { child.stdout.on('data', chunk => listener(String(chunk))) }, close: async () => { child.kill() } }),
    new Promise<never>((_, reject) => { child.once('exit', code => reject(Error(`App exited ${code}: ${raw.slice(-3000)}`))); setTimeout(() => reject(Error(`App timeout: ${raw.slice(-3000)}`)), 60_000).unref() }),
  ])
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  await until(async () => (await app!.getByTestId('header-title').textContent()).includes('Startup conversation'), 'selected fixture thread')
  await until(async () => (await app!.call('getPaintedText', {})).text.some(text => text.includes('Startup project')), 'sidebar list paint')
  if (process.env.SIDEBAR_HOME === '1') { await app.getByTestId('new-chat').click(); await Bun.sleep(500) }
  if (process.env.SIDEBAR_IDLE === '1') await app.call('blur', {})
  console.log('[sidebar] fixture ready')
  const drive = async (point: { x: number; y: number }, count: number, magnitude: number, horizontal = false) => {
    rmSync(plan + '.done', { force: true })
    writeFileSync(plan, JSON.stringify({ ...point, count, magnitude, horizontal }))
    process.kill(child.pid!, 'SIGUSR1')
    await until(async () => existsSync(plan + '.done'), 'native wheel producer', Math.max(30_000, count * 1000 / 120 + 30_000))
    return JSON.parse(readFileSync(plan + '.done', 'utf8')) as { offered: number[]; durationMs: number; deliveredAtOfferEnd: number; handlerLatencies: number[] }
  }
  if (process.env.SIDEBAR_CHECKS === '1') {
    await (await import('./checks.ts')).checkSidebar(app, out, label, theme)
  } else for (const scene of ['sidebar']) {
    const firstContentMs = 0
    const box = await app.getByTestId('sidebar-viewport').bounds()
    const point = { x: box.x + Math.min(box.width / 2, 100), y: box.y + box.height / 2 }
    if (process.env.SIDEBAR_VISUAL === '1') {
      await app.mouse.move({x:1100,y:650})
      await Bun.sleep(700)
      let firstProject: string | undefined, firstThread: string | undefined
      {
        const snapshot = await app.call('getTree', {})
        let nodes = 0, richRows = 0, motionTracks = 0
        const visit = (node: NonNullable<typeof snapshot.tree>, inside = false) => {
          const active = inside || node.testId === 'thread-list'
          if (active && !firstThread && /^thread-[\da-f]{8}-/.test(node.testId ?? '')) firstThread = node.testId
          if (active && !firstProject && /^project-[\da-f]{8}-/.test(node.testId ?? '')) firstProject = node.testId
          if (active) { nodes++; if ((node.testId?.startsWith('thread-') && node.testId !== 'thread-list') || node.testId?.startsWith('child-') || /^project-[\da-f]{8}-/.test(node.testId ?? '')) richRows++; if (node.customProps?.motion) motionTracks++ }
          node.children?.forEach(child => visit(child, active))
        }
        if (snapshot.tree) visit(snapshot.tree)
        writeFileSync(`${out}/${label}-${theme}-mounts.json`, JSON.stringify({ nodes, richRows, motionTracks, firstContentMs }, null, 2))
      }
      await app.screenshot({ path: `${out}/${label}-${theme}-${scene}.png` })
      if (firstProject) {
        await app.getByTestId(firstProject).click({ button: 2 })
        await app.getByTestId('project-menu').waitFor()
        await app.mouse.move({x:1100,y:650})
        await Bun.sleep(700)
        await app.screenshot({ path: `${out}/${label}-${theme}-${scene}-menu.png` })
        await app.getByTestId('app-ready').press('escape')
        await Bun.sleep(200)
      }
      if (firstThread) {
        await app.getByTestId(firstThread).click({button:2});await app.getByTestId('thread-menu').waitFor()
        await app.mouse.move({x:1100,y:650});await Bun.sleep(900)
        await app.screenshot({path:`${out}/${label}-${theme}-thread-menu.png`})
        await app.getByTestId('app-ready').press('escape');await Bun.sleep(200)
      }
      // The dense control initially clamps against uniform estimates. A second
      // gesture after measurement puts both controls at the actual final row.
      await app.mouse.wheel(point, 0, -100000)
      await Bun.sleep(700)
      await app.mouse.wheel(point, 0, -100000)
      await Bun.sleep(700)
      await app.screenshot({ path: `${out}/${label}-${theme}-${scene}-scrolled.png` })
      continue
    }
    if (Number(process.env.SIDEBAR_WARM_PACKETS ?? 0) > 0) await drive(point, Number(process.env.SIDEBAR_WARM_PACKETS), 6, false)
    await Bun.sleep(Number(process.env.SIDEBAR_WARM_MS ?? 10_000))
    await Bun.sleep(200)
    observedBuildMarkers.clear()
    const nativeBuildMarkersBefore = buildMarkers()
    const processesBefore = processCheck(child.pid)
    if (nativeBuildMarkersBefore.length) throw Error(`Discard/repeat ${label}/${scene}: native build active before timing (${nativeBuildMarkersBefore.join(', ')})`)
    const sampler = Bun.spawn(['bun', path.join(import.meta.dir, '../sample.ts'), '15', `GPUIX=${child.pid}`], { stdout: 'pipe', stderr: 'pipe' })
    const profile = process.env.SIDEBAR_PROFILE === '1' ? Bun.spawn(['sample', String(child.pid), '5', '-file', `${out}/${label}-${scene}-sample.txt`], { stdout: 'ignore', stderr: 'ignore' }) : undefined
    const f0 = frames.length, c0 = commits, w0 = costs.length, p0 = paints.length
    const start = performance.now()
    const input = process.env.SIDEBAR_IDLE === '1' ? (await Bun.sleep(15000), { durationMs: 15000, deliveredAtOfferEnd: 0, handlerLatencies: [] }) : await drive(point, Number(process.env.SIDEBAR_PACKETS ?? 1800), Number(process.env.SIDEBAR_MAGNITUDE ?? 10), false)
    await Bun.sleep(250)
    const resourceText = await new Response(sampler.stdout).text(); await sampler.exited; await profile?.exited
    const nativeBuildMarkersAfter = buildMarkers()
    const processesAfter = processCheck(child.pid)
    if (nativeBuildMarkersAfter.length || observedBuildMarkers.size) throw Error(`Discard/repeat ${label}/${scene}: native build active after timing (${nativeBuildMarkersAfter.join(', ')})`)
    const times = frames.slice(f0).filter(f => f.received < start + input.durationMs + 250)
    const intervals = times.slice(1).map((v, i) => v.native - times[i]!.native)
    const work = costs.slice(w0), inputPaints = paints.slice(p0)
    const result = { rowObservers: process.env.KYBERN_SIDEBAR_ROW_OBSERVERS??'default', motionSync: process.env.KYBERN_MOTION_SYNC??'1', sparse: process.env.KYBERN_SPARSE_LIST??'1', scene, fixtureScene: process.env.SIDEBAR_SCENE ?? 'settled', idle: process.env.SIDEBAR_IDLE === '1', buffer: label.startsWith('baseline') || label.startsWith('p1') ? null : Number(process.env.KYBERN_SIDEBAR_BUFFER ?? 768), firstContentMs, processesBefore, processesAfter, nativeBuildMarkersBefore, nativeBuildMarkersAfter, nativeBuildMarkersDuring: [...observedBuildMarkers], fullTree: true, cacheLayout: !label.startsWith('baseline'), bodyWindow: !label.startsWith('baseline') && !label.startsWith('p1'), fullRate: '1', opaque: true, window: '1440x900', nativeOverdraw: Number(process.env.KYBERN_OVERDRAW ?? (label.startsWith('baseline') || label.startsWith('p1') ? 512 : 128)), offeredPackets: process.env.SIDEBAR_IDLE === '1' ? 0 : Number(process.env.SIDEBAR_PACKETS ?? 1800), magnitude: Number(process.env.SIDEBAR_MAGNITUDE ?? 10), input: '120Hz synthetic precise AppKit NSEvent via GPUIView.scrollWheel:, contact + native momentum phases; no automation RPC',
      frames: times.length, p50: pct(intervals, .5), p95: pct(intervals, .95), p99: pct(intervals, .99), over16_7: intervals.filter(v => v > 16.7).length, over33: intervals.filter(v => v > 33).length, max: Math.max(0, ...intervals),
      commits: commits - c0, renderP50: pct(work.map(v => v.render), .5), renderP95: pct(work.map(v => v.render), .95), renderP99: pct(work.map(v => v.render), .99), renderMax: Math.max(0,...work.map(v => v.render)), renderOver8: work.filter(v=>v.render>8).length, layoutP95: pct(work.map(v => v.layout), .95), layoutCallsP50: pct(work.map(v => v.calls), .5),
      inputToCpuPaintP50: pct(inputPaints.map(v => v.first), .5), inputToCpuPaintP95: pct(inputPaints.map(v => v.first), .95), batchMax: Math.max(0, ...inputPaints.map(v => v.packets)),
      deliveredAtOfferEnd: input.deliveredAtOfferEnd, offeredToAppKitHandlerEndP50: pct(input.handlerLatencies ?? [], .5), offeredToAppKitHandlerEndP95: pct(input.handlerLatencies ?? [], .95),
      inputDurationMs: input.durationMs, resourceText, intervals, frameTimestamps: times, costs: work }
    results.push(result)
    writeFileSync(`${out}/${label}-${theme}.json`, JSON.stringify({ label, theme, pid: child.pid, results }, null, 2))
    console.log(JSON.stringify({ ...result, intervals: undefined, frameTimestamps: undefined, costs: undefined }))
  }
} finally {
  writeFileSync(`${out}/${label}-${theme}.log`, raw)
  try { await Promise.race([app?.close(), Bun.sleep(2000)]) } catch {}
  child.kill()
  await Promise.race([new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', () => resolve()) }), Bun.sleep(1000)])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  clearTimeout(watchdog)
  clearInterval(markerWatch)
  rmSync(plan, { force: true }); rmSync(plan + '.done', { force: true })
}
