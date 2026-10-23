// Idle probe for a thread with working subagents (lane trayidle): the real app against `composer-tray-seed.ts`, the seeded
// running thread open, then counts presented frames over a window once everything settled, and (optionally) samples CPU,
// GPU and footprint over 15 s. `--debug` logs compositor-loop rejections and island wakes to find what keeps presenting.
//   TRAY_SCRATCH=<dir> bun native/ui-lease.ts trayidle bun scripts/tray-idle-probe.ts [--dock agents] [--collapse] [--sample] [--debug]
import '../src/native/local-build.ts'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../src/requests/harness.ts'
import { Telemetry } from '../perf/bench/telemetry.ts'

const argv = process.argv.slice(2)
const arg = (name: string, fallback: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1]! : fallback)
const SCRATCH = process.env.TRAY_SCRATCH ?? '/Users/mymac/projects/ade-gpuix-scratch/trayidle'
if (!SCRATCH.includes('gpuix-scratch')) throw new Error('TRAY_SCRATCH must be under gpuix-scratch')
const ready = JSON.parse(readFileSync(path.join(SCRATCH, 'ready.json'), 'utf8'))
const theme = arg('--theme', 'dark'), windowS = Number(arg('--window', '3')), label = arg('--label', 'probe')
const debug = argv.includes('--debug')
const client = path.join(SCRATCH, `client-${label}`)
rmSync(client, { recursive: true, force: true }); mkdirSync(client, { recursive: true })
rmSync(path.join(SCRATCH, 'data', 'gpuix-ui.json'), { force: true })
const t = new Telemetry()
const log: string[] = []
const f = await launchFixture(path.resolve(import.meta.dir, 'tray-idle-app.ts'), {
  GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_APPEARANCE: theme, KYBERN_URL: ready.url, KYBERN_TOKEN: ready.token,
  KYBERN_DATA_DIR: path.join(SCRATCH, 'data'), KYBERN_CLIENT_CONFIG_DIR: client, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(SCRATCH, 'credentials'),
  KYBERN_GPUIX_THREAD: ready.title, KYBERN_REDUCED_MOTION: arg('--reduced', '0'), KYBERN_FRAME_TIMES: '1', KYBERN_FRAME_COSTS: '1',
  KYBERN_PACING_IGNORE_PHYSICAL_MOUSE: '1', TRAY_SOURCE: process.env.TRAY_SOURCE ?? '',
  ...(debug ? { KYBERN_DEBUG_COMPOSITOR: '1', KYBERN_DEBUG_ISLANDS: '1' } : {}),
  NAPI_RS_NATIVE_LIBRARY_PATH: process.env.TRAY_ADDON ?? path.resolve(import.meta.dir, '../native/build/gpuix-native.darwin-arm64.node'),
}, { stderr: chunk => { t.stderr(chunk); if (debug) log.push(chunk) } })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
try {
  const app = f.app
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  // `--no-tray`: the control, a running thread with nothing beside the turn.
  if (!argv.includes('--no-tray')) await app.getByTestId('composer-tray').waitFor({ timeoutMs: 30_000 })
  else await app.getByTestId('composer').waitFor({ timeoutMs: 30_000 })
  await sleep(2000)
  // The tray's default open state depends on what has loaded by its first render: ask for one explicitly.
  const want = argv.includes('--collapse') ? 'closed' : argv.includes('--open') ? 'open' : ''
  const isOpen = async () => ((await app.getByTestId('composer-tray').bounds())?.height ?? 0) > 40
  if (want && (await isOpen()) !== (want === 'open')) { await app.getByTestId('composer-tray-toggle').click(); await sleep(800) }
  // The sidebar's nested children of the running thread (tree connectors), and a dock tab (agents: the lineage tree).
  const dock = arg('--dock', '')
  if (dock) {
    if (!await app.getByTestId('dock-tabs').count()) { const b = await app.getByTestId('dock-toggle').bounds(); await app.mouse.click({ x: b.x + b.width / 2, y: b.y + b.height / 2 }); await sleep(1200) }
    console.log(`[probe] dock tabs ${await app.getByTestId('dock-tabs').count()}`)
    if (!await app.getByTestId(`dock-tab-${dock}`).count() && await app.getByTestId(`dock-empty-${dock}`).count()) { await app.getByTestId(`dock-empty-${dock}`).click(); await sleep(1000) }
    if (await app.getByTestId(`dock-tab-${dock}`).count()) { await app.getByTestId(`dock-tab-${dock}`).click(); await sleep(800) } else console.log(`[probe] no dock tab ${dock}`)
    // `--dock-close`: close the dock again (the Agents tab has loaded the sidebar's nested children).
    if (argv.includes('--dock-close')) { const b = await app.getByTestId('dock-toggle').bounds(); await app.mouse.click({ x: b.x + b.width / 2, y: b.y + b.height / 2 }); await sleep(1200) }
  }
  // `--children open|closed`: the running thread's nested children in the sidebar (tree connectors).
  const children = arg('--children', '')
  const childRows = async () => { type N = { testId?: string; children?: N[] }; const { tree } = await app.call('getTree', {}) as { tree: N }; let n = 0; const walk = (x: N) => { if (x.testId?.startsWith('child-') && !x.testId.startsWith('child-result-')) n++; x.children?.forEach(walk) }; walk(tree); return n }
  if (children && ((await childRows()) > 0) !== (children === 'open') && await app.getByTestId(`children-${ready.parentId}`).count()) { await app.getByTestId(`children-${ready.parentId}`).click(); await sleep(800) }
  if (children) console.log(`[probe] sidebar child rows ${await childRows()}`)
  await app.mouse.move({ x: 1, y: 1 })
  await sleep(Number(arg('--warmup', '6')) * 1000)
  const before = log.join('').split('\n').filter(l => l.includes('[compositor-loops]')).slice(-2)
  log.length = 0
  const mark = t.mark()
  const start = performance.now()
  // `--sample`: CPU, GPU and footprint over the same window (perf/sample.ts), concurrent with the frame count.
  const sample = argv.includes('--sample') ? new Promise<string>(resolve => { const p = Bun.spawn(['bun', path.join(import.meta.dir, '../perf/sample.ts'), String(windowS), `GPUIX=${f.pid}`], { stdout: 'pipe' }); void new Response(p.stdout).text().then(resolve) }) : null
  await sleep(windowS * 1000)
  if (sample) console.log((await sample).trim().split('\n').pop())
  const frames = t.submissions.length - mark.frames, seconds = (performance.now() - start) / 1000
  const work = t.result(mark).work
  console.log(`[probe] ${label}: ${frames} frames in ${seconds.toFixed(1)} s (${(frames / seconds).toFixed(1)}/s), ${work.reactCommits} commits, full draws ${t.costs.length - mark.costs}`)
  if (debug) {
    console.log(`[probe] last compositor before the window: ${before.join(' | ')}`)
    const text = log.join('')
    const out = path.join(SCRATCH, `probe-${label}.log`); writeFileSync(out, text)
    const counts = new Map<string, number>()
    for (const line of text.split('\n')) { const key = line.replace(/[\d.]+/g, '#').slice(0, 160); if (!line.includes('[kybern-submit]') && !line.includes('[kybern-frame]')) counts.set(key, (counts.get(key) ?? 0) + 1) }
    for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`${String(n).padStart(6)}  ${k}`)
  }
  if (argv.includes('--bounds')) for (const id of [`children-${ready.parentId}`, 'dock-tabs', 'matrix-loader', 'composer-drop-zone', 'composer-tray', 'thread-request', 'scroll-to-bottom', 'composer-overlay']) for (const { bounds: b } of await app.getByTestId(id).all()) console.log(`[bounds] ${id} ${b ? `${b.x},${b.y} ${b.width}x${b.height}` : 'none'}`)
  if (argv.includes('--tree')) {
    // What paints after each loader inside its bounds (tree order is paint order, absent deferred popups).
    type N = { id: number; type: string; text?: string; testId?: string; style?: Record<string, unknown>; bounds?: { x: number; y: number; width: number; height: number }; children?: N[] }
    const { tree } = await app.call('getTree', {}) as { tree: N }
    const order: { node: N; depth: number; end: number }[] = []
    const walk = (n: N, depth: number) => { const at = order.length; order.push({ node: n, depth, end: 0 }); for (const c of n.children ?? []) walk(c, depth + 1); order[at]!.end = order.length }
    walk(tree, 0)
    const hit = (a: N['bounds'], b: N['bounds'], m = 0) => !!a && !!b && a.x - m < b.x + b.width && b.x < a.x + a.width + m && a.y - m < b.y + b.height && b.y < a.y + a.height + m
    order.forEach((o, i) => {
      if (o.node.testId !== 'matrix-loader') return
      const own = o.end
      const after = order.slice(own).filter(x => hit(x.node.bounds, o.node.bounds, Number(arg('--margin', '0'))))
      console.log(`[tree] loader ${o.node.id} at ${JSON.stringify(o.node.bounds)}: ${after.length} after`)
      const halo = order.slice(own).filter(x => { const st = x.node.style ?? {}; return 'boxShadow' in st || 'backdropFilter' in st || 'filter' in st || JSON.stringify(st).includes('blur') }).filter(x => hit(x.node.bounds, o.node.bounds, 80))
      for (const x of halo.slice(0, 15)) console.log(`   halo? ${x.node.type} ${x.node.testId ?? ''} ${JSON.stringify(x.node.bounds)} ${JSON.stringify(x.node.style).slice(0, 300)}`)
      for (const x of after.slice(0, 25)) console.log(`   ${x.node.type} ${x.node.testId ?? ''} ${x.node.text ? JSON.stringify(x.node.text.slice(0, 30)) : ''} ${JSON.stringify(x.node.bounds)} ${JSON.stringify(x.node.style ?? {}).slice(0, 220)}`)
      void i
    })
  }
  // `--shot`: a window capture, in TRAY_SHOTS (default: the scratch dir, which a fresh seed wipes).
  if (argv.includes('--shot')) await app.screenshot({ path: path.join(process.env.TRAY_SHOTS ?? SCRATCH, `probe-${label}.png`) })
} finally { await f.close() }
process.exit(0)
