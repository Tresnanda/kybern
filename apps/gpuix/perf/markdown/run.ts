import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { connectStdio } from '@gpuix/react/automation'
import { actionFixture } from '../../src/pulls/verify.fixture.ts'
import { assertScratchEnv } from '../../src/requests/harness.ts'
import { openDock, painted, until } from '../../scripts/dock-waits.ts'

assertScratchEnv({ KYBERN_URL: '' })
const data = process.env.KYBERN_DATA_DIR!
const fixture = JSON.parse(readFileSync(path.join(data, 'fixture.json'), 'utf8')) as { threadId: string }
const out = '/Users/mymac/projects/ade/previews/gpuix/perf/markdown'
mkdirSync(out, { recursive: true })
const prFixture=process.env.MARKDOWN_PR==='1'?actionFixture({long:true}):null
const label = process.argv[2] ?? 'baseline', theme = process.env.KYBERN_APPEARANCE ?? 'dark'
const plan = path.join(data, `wheel-${process.pid}.json`)
// Saved selection wins over KYBERN_GPUIX_THREAD during boot. Every isolated
// run restores the same selected thread, dock width and initial geometry.
writeFileSync(path.join(data, 'gpuix-ui.json'), JSON.stringify({
  'kybern.dock.choices': [[fixture.threadId, { open: false, tabs: [], tab: null, width: 850 }]],
  'kybern.workspace.selected': { kind: 'thread', id: fixture.threadId },
  'kybern.split-view.v1': { version: 1, root: { kind: 'leaf', id: 'main', threadId: fixture.threadId }, focusedPaneId: 'main' },
}))
const child = spawn('bun', [path.join(import.meta.dir, prFixture?'pr-entry.ts':'app.ts')], { env: {
  ...process.env, ...prFixture?.env, MARKDOWN_NATIVE_WHEEL:prFixture?'1':'0', MD_PR_BEFORE:label.startsWith('before')?'1':'0', ...(label.startsWith('before') && process.env.MARKDOWN_CURRENT_NATIVE !== '1' ? { NAPI_RS_NATIVE_LIBRARY_PATH: path.resolve(import.meta.dir, '../../native/build/markdown-before.node') } : {}), KYBERN_URL: prFixture?.env.KYBERN_URL??'', KYBERN_GPUIX_THREAD: fixture.threadId,
  EXPLORER_PLAN: plan, KYBERN_APPEARANCE: theme, KYBERN_WINDOW_SIZE: '1440x900',
  GPUIX_BACKGROUND: '1', KYBERN_FRAME_TIMES: '1', KYBERN_FRAME_COSTS: '1', KYBERN_FULL_RATE: '1',
  EXPLORER_BASE_REF: 'd4269d55', EXPLORER_BASELINE: (label.startsWith('baseline') || label.startsWith('before')) ? '1' : '0',
}, stdio: ['pipe', 'pipe', 'pipe'] })
const helpers = new Set<{ kill(signal?: number | NodeJS.Signals): unknown }>()
const stopChildren = () => { child.kill('SIGKILL'); for (const helper of helpers) helper.kill('SIGKILL') }
process.once('SIGINT', stopChildren)
process.once('SIGTERM', stopChildren)
const watchdog = setTimeout(() => { stopChildren(); process.exit(124) }, 270_000)
let raw = '', pending = '', commits = 0
const frames: { native: number; received: number }[] = [], costs: { render: number; layout: number; calls: number }[] = []
const paints: { packets: number; first: number; last: number }[] = []
child.once('exit', code => { if(code!==0) { writeFileSync(`${out}/${label}-${theme}.log`,raw); } })
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
    if (line.includes('[explorer-commit]')) commits++
  }
  if (process.env.EXPLORER_DEBUG === '1') writeFileSync(`${out}/${label}-${theme}.live.log`, raw)
})
const pct = (values: number[], p: number) => [...values].sort((a,b) => a-b)[Math.min(values.length - 1, Math.floor(values.length * p))] ?? null
const buildMarkers = () => Bun.spawnSync(['sh', '-c', 'ls /tmp/kybern-gpuix-native-build.* 2>/dev/null || true']).stdout.toString().trim().split('\n').filter(Boolean)
const processInventories: { at: string; processes: string[] }[] = []
const checkProcesses = () => {
  const listing = spawnSync('pgrep', ['-fl', 'bun .*ade-gpuix'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean)
  processInventories.push({ at: new Date().toISOString(), processes: listing })
  const foreign = listing.filter(line => {
    const pid = Number(line.split(' ')[0])
    return pid !== process.pid && pid !== child.pid && /\/(?:app|entry|pr-entry|main|[^ /]*(?:lab|fixture)[^ /]*)\.tsx?(?:\s|$)/.test(line)
  })
  if (foreign.length) throw Error(`Discard/repeat: unrelated GPUIX apps/fixtures/labs are alive: ${foreign.join('; ')}`)
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
  const sceneOpenedAt=performance.now()
  let treeFirstContentMs=0
  if(prFixture) {
    await app.getByTestId('rail-pulls').click();await app.getByTestId('pr-row-108').waitFor();await app.getByTestId('pr-row-108').click();await app.getByTestId('pr-summary').waitFor()
    await until(async () => (await app!.call('getPaintedText',{})).text.some((text:string)=>text.includes('Verification 1')), 'PR Summary formatted content',60_000)
    console.log('[markdown] PR Summary ready')
    treeFirstContentMs=performance.now()-sceneOpenedAt
  } else {
  await until(async () => (await app!.getByTestId('header-title').textContent()).includes('Explorer performance'), 'selected fixture thread')
  console.log('[explorer] fixture thread ready')
  if (!await app.getByTestId('right-dock').count()) await app.getByTestId('app-ready').press('cmd-j')
  await openDock(app.getByTestId('right-dock'))
  const treeOpenedAt = performance.now()
  await app.getByTestId('dock-add').click(); await app.getByTestId('dock-add-explorer').click()
  await app.getByTestId('dock-file-tree-focus').waitFor({ timeoutMs: 60_000 })
  await app.getByTestId('dock-file-folder-00').waitFor({ timeoutMs: 60_000 })
  await painted(app.getByTestId('dock-file-folder-00'))
  treeFirstContentMs = performance.now() - treeOpenedAt
  console.log('[explorer] tree ready')
  }
  const drive = async (point: { x: number; y: number }, count: number, magnitude: number, horizontal = false) => {
    rmSync(plan + '.done', { force: true })
    writeFileSync(plan, JSON.stringify({ ...point, count, magnitude, horizontal }))
    process.kill(child.pid!, 'SIGUSR1')
    await until(async () => existsSync(plan + '.done'), 'native wheel producer', Math.max(30_000, count * 1000 / 120 + 30_000))
    return JSON.parse(readFileSync(plan + '.done', 'utf8')) as { offered: number[]; durationMs: number; deliveredAtOfferEnd: number; handlerLatencies: number[] }
  }
  for (const scene of (process.env.EXPLORER_SCENES ?? (prFixture?'summary':'tree,preview.md,long.md,long.ts,minified.ts,large.json')).split(',')) {
    const rendered=scene.endsWith('.md') && (scene==='preview.md' || !label.startsWith('before'))
    const opened = performance.now()
    if (scene !== 'tree' && !prFixture) {
      await app.getByTestId('dock-file-search').fill(scene)
      const relativePath = scene === 'preview.md' || scene === 'long.md' || !scene.endsWith('.md') ? scene : `markdown-cases/${scene}`
      const fileRow = app.getByTestId(`dock-file-${relativePath}`)
      await fileRow.waitFor({ timeoutMs: 15_000 })
      await painted(fileRow)
      await fileRow.click()
      await painted(app.getByTestId(rendered ? 'dock-file-content' : 'dock-code-chunk-0'))
      if (rendered) {
        const title:Record<string,string>={'long.md':'Long preview','preview.md':'Rendered preview','two-mib.md':'two MiB document','giant-paragraph.md':'giant paragraph','giant-inline.md':'giant inline paragraph','giant-table.md':'giant table','giant-code.md':'giant code fence','giant-list.md':'giant list'}
        await until(async () => (await app!.call('getPaintedText', {})).text.some((text:string)=>text.includes(title[scene]??'Section 0')), 'first formatted content',60_000)
      }
      if (process.env.EXPLORER_COMBINED === '1') {
        await app.getByTestId('dock-file-search').fill('')
        await painted(app.getByTestId('dock-file-folder-00'))
      }
    }
    const firstContentMs = scene === 'tree' || prFixture ? treeFirstContentMs : performance.now() - opened
    if (process.env.EXPLORER_LIFECYCLE === '1') {
      const viewport = await app.getByTestId('dock-file-content').bounds()
      await app.mouse.wheel({ x: viewport.x + viewport.width / 2, y: viewport.y + viewport.height / 2 }, 0, -1_000_000_000)
      await until(async () => (await app!.call('getPaintedText', {})).text.join(' ').replace(/\s+/g, ' ').includes('END sentinel reachable.'), 'final formatted content', 60_000)
      await app.getByTestId('dock-file-close').click()
      await Bun.sleep(500)
      const result = { scene, firstContentMs, endReached: true, closed: true }
      results.push(result)
      writeFileSync(`${out}/${label}-${theme}.json`, JSON.stringify({ label, theme, pid: child.pid, results }, null, 2))
      console.log(JSON.stringify(result))
      continue
    }
    const box = await app.getByTestId(prFixture ? 'pr-summary' : scene === 'tree' ? 'dock-file-tree-focus' : rendered ? 'dock-file-content' : 'dock-file-horizontal').bounds()
    const point = { x: box.x + Math.min(box.width / 2, 100), y: box.y + box.height / 2 }
    if (process.env.EXPLORER_VISUAL === '1') {
      await Bun.sleep(700)
      if (scene === 'tree') {
        const snapshot = await app.call('getTree', {})
        let nodes = 0, richRows = 0, motionTracks = 0
        const visit = (node: NonNullable<typeof snapshot.tree>, inside = false) => {
          const active = inside || node.testId === 'dock-file-tree'
          if (active) { nodes++; if (node.testId?.startsWith('dock-file-') && node.testId !== 'dock-file-tree') richRows++; if (node.customProps?.motion) motionTracks++ }
          node.children?.forEach(child => visit(child, active))
        }
        if (snapshot.tree) visit(snapshot.tree)
        writeFileSync(`${out}/${label}-${theme}-mounts.json`, JSON.stringify({ nodes, richRows, motionTracks, treeFirstContentMs }, null, 2))
      }
      await app.screenshot({ path: `${out}/${label}-${theme}-${scene}.png` })
      await drive(point, 120, 8, scene === 'minified.ts')
      await Bun.sleep(400)
      await app.screenshot({ path: `${out}/${label}-${theme}-${scene}-scrolled.png` })
      continue
    }
    if (Number(process.env.EXPLORER_WARM_PACKETS ?? 0) > 0) await drive(point, Number(process.env.EXPLORER_WARM_PACKETS), 6, scene === 'minified.ts')
    else await Bun.sleep(10_000)
    await Bun.sleep(200)
    observedBuildMarkers.clear()
    const nativeBuildMarkersBefore = buildMarkers()
    if (nativeBuildMarkersBefore.length) throw Error(`Discard/repeat ${label}/${scene}: native build active before timing (${nativeBuildMarkersBefore.join(', ')})`)
    checkProcesses()
    const sampler = Bun.spawn(['bun', path.join(import.meta.dir, '../sample.ts'), '15', `GPUIX=${child.pid}`], { stdout: 'pipe', stderr: 'pipe' })
    helpers.add(sampler)
    const profile = process.env.EXPLORER_PROFILE === '1' ? Bun.spawn(['sample', String(child.pid), '5', '-file', `${out}/${label}-${scene}-sample.txt`], { stdout: 'ignore', stderr: 'ignore' }) : undefined
    if (profile) helpers.add(profile)
    const f0 = frames.length, c0 = commits, w0 = costs.length, p0 = paints.length
    const start = performance.now()
    const input = await drive(point, Number(process.env.EXPLORER_PACKETS ?? 1800), Number(process.env.EXPLORER_MAGNITUDE ?? 10), scene === 'minified.ts')
    await Bun.sleep(250)
    const resourceText = await new Response(sampler.stdout).text(); await sampler.exited; await profile?.exited
    helpers.delete(sampler); if (profile) helpers.delete(profile)
    checkProcesses()
    const nativeBuildMarkersAfter = buildMarkers()
    if (nativeBuildMarkersAfter.length || observedBuildMarkers.size) throw Error(`Discard/repeat ${label}/${scene}: native build active after timing (${nativeBuildMarkersAfter.join(', ')})`)
    const times = frames.slice(f0).filter(f => f.received < start + input.durationMs + 250)
    const intervals = times.slice(1).map((v, i) => v.native - times[i]!.native)
    const work = costs.slice(w0), inputPaints = paints.slice(p0)
    const result = { scene, firstContentMs, nativeBuildMarkersBefore, nativeBuildMarkersAfter, nativeBuildMarkersDuring: [...observedBuildMarkers], fullTree: scene === 'tree' || process.env.EXPLORER_COMBINED === '1', fullRate: '1', offeredPackets: Number(process.env.EXPLORER_PACKETS ?? 1800), magnitude: Number(process.env.EXPLORER_MAGNITUDE ?? 10), input: '120Hz synthetic precise AppKit NSEvent via GPUIView.scrollWheel:, contact + native momentum phases; no automation RPC',
      frames: times.length, p50: pct(intervals, .5), p95: pct(intervals, .95), p99: pct(intervals, .99), over16_7: intervals.filter(v => v > 16.7).length, over33: intervals.filter(v => v > 33).length, max: Math.max(0, ...intervals),
      commits: commits - c0, renderP50: pct(work.map(v => v.render), .5), renderP95: pct(work.map(v => v.render), .95), layoutP95: pct(work.map(v => v.layout), .95), layoutCallsP50: pct(work.map(v => v.calls), .5),
      inputToCpuPaintP50: pct(inputPaints.map(v => v.first), .5), inputToCpuPaintP95: pct(inputPaints.map(v => v.first), .95), batchMax: Math.max(0, ...inputPaints.map(v => v.packets)),
      deliveredAtOfferEnd: input.deliveredAtOfferEnd, offeredToAppKitHandlerEndP50: pct(input.handlerLatencies ?? [], .5), offeredToAppKitHandlerEndP95: pct(input.handlerLatencies ?? [], .95),
      inputDurationMs: input.durationMs, resourceText, intervals }
    results.push(result)
    writeFileSync(`${out}/${label}-${theme}.json`, JSON.stringify({ label, theme, pid: child.pid, results }, null, 2))
    console.log(JSON.stringify({ ...result, intervals: undefined }))
  }
  if (process.env.EXPLORER_VISUAL !== '1' && process.env.EXPLORER_IDLE === '1') {
    await app.getByTestId('dock-file-close').click()
    await Bun.sleep(20_000)
    const before = frames.length
    observedBuildMarkers.clear()
    const nativeBuildMarkersBefore = buildMarkers()
    if (nativeBuildMarkersBefore.length) throw Error('Discard/repeat idle: native build active before sample')
    checkProcesses()
    const idle = Bun.spawn(['bun', path.join(import.meta.dir, '../sample.ts'), '15', `GPUIX=${child.pid}`], { stdout: 'pipe' })
    helpers.add(idle)
    const resourceText = await new Response(idle.stdout).text(); await idle.exited
    helpers.delete(idle)
    checkProcesses()
    const nativeBuildMarkersAfter = buildMarkers()
    if (nativeBuildMarkersAfter.length || observedBuildMarkers.size) throw Error('Discard/repeat idle: native build active after sample')
    const result = { scene: 'closed-idle', frames: frames.length - before, nativeBuildMarkersBefore, nativeBuildMarkersAfter, nativeBuildMarkersDuring: [...observedBuildMarkers], resourceText }
    results.push(result); console.log(JSON.stringify(result))
    writeFileSync(`${out}/${label}-${theme}.json`, JSON.stringify({ label, theme, pid: child.pid, results }, null, 2))
  }
} finally {
  writeFileSync(`${out}/${label}-${theme}.log`, raw)
  writeFileSync(`${out}/${label}-${theme}-processes.json`, JSON.stringify(processInventories, null, 2))
  try { await Promise.race([app?.close(), Bun.sleep(2000)]) } catch {}
  child.kill()
  await Promise.race([new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', () => resolve()) }), Bun.sleep(1000)])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  prFixture?.close()
  for (const helper of helpers) helper.kill('SIGKILL')
  process.off('SIGINT', stopChildren); process.off('SIGTERM', stopChildren)
  clearTimeout(watchdog)
  clearInterval(markerWatch)
  rmSync(plan, { force: true }); rmSync(plan + '.done', { force: true })
}
