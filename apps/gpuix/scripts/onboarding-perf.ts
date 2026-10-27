// Per-draw cost of every moment of the first-run flow (hero intro, each scene change and Back, the in-scene changes, the handoff).
// A draw is one `[kybern-work]` line (KYBERN_FRAME_COSTS=1): a full window render and its layout. Paint-only frames (retained
// transforms) print nothing, so a moment that only tweens paint shows no draws. Never read frame timestamps for this: gaps between
// frames include idle time.
//   bun scripts/onboarding-perf.ts <label> [--theme dark|light] [--runs 2] [--islands]
// Starts its own scratch daemon per run (fresh data dir, BENCH_PORT, default 4391) from `target/debug/kybernd`, and writes
// <BENCH_OUT>/<label>.json. The scan reads this Mac's agent histories (read-only); an import writes into the scratch store only.
import '../src/native/local-build.ts'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchFixture } from '../src/requests/harness.ts'

const arg = (name: string, fallback: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : fallback)
const label = process.argv[2] ?? 'run'
const theme = arg('--theme', 'dark')
const runs = Number(arg('--runs', '2'))
const islands = process.argv.includes('--islands')
const repo = path.resolve(import.meta.dir, '../../..')
const SCRATCH = process.env.BENCH_SCRATCH ?? path.join(tmpdir(), 'kybern-onboarding-bench')
const out = process.env.BENCH_OUT ?? SCRATCH
const port = Number(process.env.BENCH_PORT ?? 4391)
const kybernd = path.join(process.env.CARGO_TARGET_DIR ?? path.join(repo, 'target'), 'debug', 'kybernd')
mkdirSync(out, { recursive: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Draw { at: number; render: number; layout: number; calls: number }
interface Moment { name: string; t0: number; t1: number }
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0 }
const round = (n: number) => Math.round(n * 10) / 10

/** Every daemon serving `dir`: the one started here and any the window started or restarted for it (they outlive the window). */
function stopDaemons(dir: string) {
  spawnSync('pkill', ['-f', `kybernd.*${dir}`])
  if (spawnSync('pgrep', ['-f', `kybernd.*${dir}`]).status === 0) spawnSync('pkill', ['-9', '-f', `kybernd.*${dir}`])
}

async function startDaemon(dir: string): Promise<ChildProcess> {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const env = { ...process.env }
  delete env.KYBERN_URL
  delete env.KYBERN_TOKEN
  const child = spawn(kybernd, ['--data-dir', dir, '--port', String(port)], { env, stdio: 'ignore' })
  for (let i = 0; i < 100 && !existsSync(path.join(dir, 'daemon.port')); i++) await sleep(100)
  await sleep(300)
  return child
}

async function run(n: number) {
  const dir = path.join(SCRATCH, `run-${label}-${n}`)
  const daemon = await startDaemon(path.join(dir, 'data'))
  const draws: Draw[] = []
  const islandLines: { at: number; line: string }[] = []
  let fadeAt = 0
  let rest = ''
  const watch = (chunk: string) => {
    const at = performance.now()
    const lines = (rest + chunk).split('\n'); rest = lines.pop() ?? ''
    for (const line of lines) {
      const m = /^\[kybern-work\] renderMs=([\d.]+) layoutMs=([\d.]+) layoutCalls=(\d+)/.exec(line)
      if (m) draws.push({ at, render: Number(m[1]), layout: Number(m[2]), calls: Number(m[3]) })
      else if (line.startsWith('[kybern-onboarding] fade')) fadeAt = at
      else if (islands && (line.startsWith('[islands]') || line.startsWith('[mtrace]'))) islandLines.push({ at, line })
    }
  }
  const f = await launchFixture(path.join(import.meta.dir, '..', 'src/main.tsx'), {
    GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_FRAME_COSTS: '1', KYBERN_WINDOW_SIZE: '1440x900', KYBERN_ONBOARDING: '1',
    KYBERN_DATA_DIR: path.join(dir, 'data'), KYBERN_CLIENT_CONFIG_DIR: path.join(dir, 'client'), KYBERN_GPUIX_CREDENTIALS_DIR: path.join(dir, 'credentials'),
    ...(process.env.BENCH_SCENE ? { KYBERN_ONBOARDING_SCENE: process.env.BENCH_SCENE } : {}),
    KYBERN_URL: '', KYBERN_TOKEN: '', ...(islands ? { KYBERN_DEBUG_ISLANDS: '1', KYBERN_MOTION_TRACE: '1' } : {}),
  }, { stderr: watch })
  const a = f.app
  const moments: Moment[] = []
  const has = async (id: string) => { try { return (await a.getByTestId(id).count()) > 0 } catch { return false } }
  const until = async (id: string, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await has(id)) return true; await sleep(50) } return false }
  const click = async (id: string) => {
    if (!await until(id, 4000)) { console.error(`skipped a click: ${id} is not on screen`); return }
    const c = await a.getByTestId(id).center(); await a.mouse.click(c)
  }
  let stopped = false
  const moment = async (name: string, action: () => Promise<unknown>, ms: number) => {
    if (stopped) return
    if (process.env.BENCH_STOP && name === process.env.BENCH_STOP) stopped = true
    const t0 = performance.now()
    await action()
    await sleep(ms)
    moments.push({ name, t0, t1: performance.now() })
  }
  try {
    if (process.env.BENCH_SCENE === 'projects') {
      if (!await until('projects-mode-all', 60000)) throw new Error('the projects scene never appeared')
      await sleep(6000)
      for (let i = 0; i < 2; i++) {
        await moment('projects: mode → all', () => click('projects-mode-all'), 1200)
        await moment('projects: mode → none', () => click('projects-mode-none'), 1200)
        await moment('projects: mode → latest', () => click('projects-mode-latest'), 1200)
        await moment('projects: select all / clear', () => click('projects-suggested-all'), 900)
      }
      stopped = true
    } else if (process.env.BENCH_SCENE === 'prefs') {
      if (!await until('prefs-material-full', 60000)) throw new Error('the preferences scene never appeared')
      await sleep(3000)
      await click('prefs-material-full'); await sleep(1000)
      const findSlider = async () => (await a.getByType('div').all()).find((node) => node.testId?.startsWith('prefs-slider-'))?.testId
      // Adjust may already be open (it remembers); open it if no slider shows.
      if (!await findSlider()) { await click('prefs-adjust'); await sleep(1000) }
      const slider = await findSlider()
      if (!slider) throw new Error('no slider after Adjust')
      for (let i = 0; i < 3; i++) await moment('prefs: slider drag', () => a.getByTestId(slider).dragBy(i % 2 ? 60 : -60, 0, { steps: 20 } as never), 900)
      stopped = true
    }
    else await fullFlow()
  } finally {
    await f.close()
    daemon.kill()
    stopDaemons(path.join(dir, 'data'))
  }
  async function fullFlow() {
    if (!await until('onboarding-start', 60000)) throw new Error('the hero never appeared')
    await moment('hero intro', async () => {}, 2600)
    await moment('hero → agents', () => click('onboarding-start'), 1600)
    await moment('agents: detection settling', async () => {}, 3000)
    await sleep(1500)
    if (await has('agent-claude-code')) {
      await moment('agents: popover open', () => click('agent-claude-code'), 700)
      if (await has('agent-popover')) await moment('agents: popover close', () => a.getByTestId('agent-popover').press('escape'), 700)
    }
    for (const kind of ['omp', 'pi', 'opencode', 'codex']) {
      await click(`agent-${kind}`); await sleep(500)
      const button = await has('agent-install') ? 'agent-install' : await has('agent-signin-terminal') ? 'agent-signin-terminal' : null
      if (!button) { if (await has('agent-popover')) await a.getByTestId('agent-popover').press('escape').catch(() => {}); await sleep(400); continue }
      await moment('agents: terminal sheet open', () => click(button), 1000)
      await moment('agents: terminal sheet close', () => click('agent-sheet-close'), 800)
      break
    }
    await sleep(500)
    await moment('agents → projects', () => click('agents-continue'), 1600)
    await moment('projects: rows arriving', async () => {}, 4000)
    if (process.env.BENCH_DUMP) writeFileSync(path.join(out, 'tree.json'), JSON.stringify((await a.getByType('div').all()).map((n) => ({ id: (n as { id?: number }).id, testId: n.testId })).filter((n) => n.testId)))
    await sleep(1000)
    await moment('projects: mode → all', () => click('projects-mode-all'), 1200)
    await moment('projects: mode → none', () => click('projects-mode-none'), 1200)
    await moment('projects: mode → latest', () => click('projects-mode-latest'), 1200)
    if (await has('projects-suggested-all')) {
      await moment('projects: select all / clear', () => click('projects-suggested-all'), 800)
      await moment('projects: select all / clear', () => click('projects-suggested-all'), 800)
    }
    await moment('projects → agents (Back)', () => click('projects-back'), 1400)
    await sleep(600)
    await moment('agents → projects', () => click('agents-continue'), 1600)
    await sleep(800)
    await moment('projects: import progress', () => click('projects-primary'), 4000)
    await moment('projects → preferences', () => click('projects-primary'), 1600)
    await sleep(600)
    await moment('prefs: theme change', () => click(theme === 'dark' ? 'prefs-theme-light' : 'prefs-theme-dark'), 1000)
    await moment('prefs: theme change', () => click(theme === 'dark' ? 'prefs-theme-dark' : 'prefs-theme-light'), 1000)
    if (await has('prefs-material-full')) {
      await moment('prefs: window material change', () => click('prefs-material-full'), 1000)
      if (await has('prefs-adjust')) await moment('prefs: Adjust opening', () => click('prefs-adjust'), 900)
      await moment('prefs: window material change', () => click('prefs-material-solid'), 1000)
    }
    const modes = (await a.getByType('div').all()).map((node) => node.testId).filter((id): id is string => !!id?.startsWith('prefs-mode-'))
    for (const id of [...modes.slice(1), modes[0]].filter(Boolean)) await moment('prefs: permission highlight', () => click(id!), 700)
    await moment('preferences → projects (Back)', () => click('onboarding-prefs-back'), 1400)
    await sleep(600)
    await moment('projects → preferences', () => click('projects-primary'), 1600)
    await sleep(600)
    await moment('preferences → app', () => click('onboarding-done'), 3000)
  }
  // The handoff in two: the app mounting under the still-opaque welcome, and the welcome's visible fade (600 ms) once it starts.
  const hand = moments.find((m) => m.name === 'preferences → app')
  if (hand && fadeAt > hand.t0) moments.splice(moments.indexOf(hand), 1, { name: 'preferences → app: under the welcome', t0: hand.t0, t1: fadeAt - 1 }, { name: 'preferences → app: the fade', t0: fadeAt, t1: hand.t1 })
  const rows = moments.map((m) => {
    const in_ = draws.filter((d) => d.at >= m.t0 && d.at <= m.t1 + 30)
    const r = in_.map((d) => d.render)
    return { name: m.name, draws: in_.length, mean: round(r.reduce((s, x) => s + x, 0) / Math.max(1, r.length)), p95: round(pct(r, 0.95)), max: round(Math.max(0, ...r)), over16: r.filter((x) => x > 16.7).length, over8: r.filter((x) => x > 8).length, layoutCallsMax: Math.max(0, ...in_.map((d) => d.calls)), layoutCallsMean: Math.round(in_.reduce((s, d) => s + d.calls, 0) / Math.max(1, in_.length)), series: in_.map((d) => round(d.render)), ats: in_.map((d) => Math.round(d.at - m.t0)), layout: in_.map((d) => round(d.layout)), calls: in_.map((d) => d.calls), ...(islands ? { islands: islandLines.filter((l) => l.at >= m.t0 && l.at <= m.t1 + 30).map((l) => l.line).slice(0, 5000) } : {}) }
  })
  rmSync(dir, { recursive: true, force: true })
  return rows
}

const all: Awaited<ReturnType<typeof run>>[] = []
for (let i = 1; i <= runs; i++) all.push(await run(i))
writeFileSync(path.join(out, `${label}-${theme}.json`), JSON.stringify(all, null, 1))
// Fold the runs per moment name (a moment that happens twice in a run counts both).
const names = [...new Set(all.flat().map((r) => r.name))]
console.log(`moment | draws | mean | p95 | max | >16.7 | >8 | layout calls (mean/max)`)
for (const name of names) {
  const rows = all.flat().filter((r) => r.name === name)
  const series = rows.flatMap((r) => r.series)
  const draws = series.length
  console.log(`${name} | ${draws} | ${round(series.reduce((s, x) => s + x, 0) / Math.max(1, draws))} | ${round(pct(series, 0.95))} | ${round(Math.max(0, ...series))} | ${series.filter((x) => x > 16.7).length} | ${series.filter((x) => x > 8).length} | ${Math.round(rows.reduce((s, r) => s + r.layoutCallsMean * r.draws, 0) / Math.max(1, draws))}/${Math.max(0, ...rows.map((r) => r.layoutCallsMax))}`)
}
