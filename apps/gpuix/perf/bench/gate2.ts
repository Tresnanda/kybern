/**
 * Interleaved translucency gate (`perf/translucency-zeron-research.md` §5): one build, modes pinned by environment,
 * arms interleaved A B B A across rounds, seeded scenario order, a throw-away warm-up pass, a thermal check before each
 * pass. Every window lands as one JSON line; `gate2-report.ts` turns the file into tables.
 *
 *   bun perf/bench/gate2.ts --out perf/bench/results/gate2-2026-10-22.jsonl --rounds 4 --seed 20261022 \
 *       [--arms window,sidebar,solid,solid-aa] [--scenarios streaming,thread-scroll,sidebar-scroll,idle-home] [--tag primary] [--fresh]
 *
 * `--fresh` drops `--keep-data`, so every launch re-seeds the scratch dataset. Needed for `streaming` when no `idle-home` pass runs between launches:
 * the kept dataset's running thread stops painting after about three streaming launches ("No painted content").
 * Resumable: a (tag, round, arm, scenario) already in the output file is skipped. Needs KYBERN_DATA_DIR (a scratch
 * directory) and, optionally, KYBERN_BENCH_PORT. The raw per-invocation `run.ts` result files are deleted after their
 * windows are extracted.
 */
import {appendFileSync,existsSync,readFileSync,rmSync,mkdirSync,writeFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import path from 'node:path'
import {plan} from './gate2-stats.ts'
import type {Result} from './model.ts'

/** Environment per arm. Everything that picks the material is pinned, so arms differ by one variable. */
export const ARMS: Record<string, Record<string, string>> = {
  window: {KYBERN_WINDOW_MATERIAL: 'window', KYBERN_WINDOW_OPACITY: '90', KYBERN_WINDOW_BLUR: '64'},
  sidebar: {KYBERN_WINDOW_MATERIAL: 'sidebar', KYBERN_WINDOW_OPACITY: '90', KYBERN_WINDOW_BLUR: '64'},
  solid: {KYBERN_WINDOW_MATERIAL: 'solid', KYBERN_WINDOW_OPACITY: '90', KYBERN_WINDOW_BLUR: '64'},
  'solid-aa': {KYBERN_WINDOW_MATERIAL: 'solid', KYBERN_WINDOW_OPACITY: '90', KYBERN_WINDOW_BLUR: '64'},
  'window-auto': {KYBERN_WINDOW_MATERIAL: 'window', KYBERN_WINDOW_OPACITY: '90', KYBERN_WINDOW_BLUR: 'auto'},
  'sidebar-sf': {KYBERN_WINDOW_MATERIAL: 'sidebar', KYBERN_WINDOW_OPACITY: '90', KYBERN_WINDOW_BLUR: '64', KYBERN_TRANSLUCENCY_SINGLE_FILL: '1'},
  'solid-sf': {KYBERN_WINDOW_MATERIAL: 'solid', KYBERN_WINDOW_OPACITY: '90', KYBERN_WINDOW_BLUR: '64', KYBERN_TRANSLUCENCY_SINGLE_FILL: '1'},
  'window-light': {KYBERN_WINDOW_MATERIAL: 'window', KYBERN_WINDOW_OPACITY: '90', KYBERN_WINDOW_BLUR: '64', KYBERN_APPEARANCE: 'light'},
  'solid-light': {KYBERN_WINDOW_MATERIAL: 'solid', KYBERN_WINDOW_OPACITY: '90', KYBERN_WINDOW_BLUR: '64', KYBERN_APPEARANCE: 'light'},
}
/** Variables an arm may set; they are cleared before each launch so an inherited value cannot leak between arms. */
const PINNED = ['KYBERN_WINDOW_MATERIAL', 'KYBERN_WINDOW_OPACITY', 'KYBERN_WINDOW_BLUR', 'KYBERN_TRANSLUCENCY_SINGLE_FILL', 'KYBERN_APPEARANCE', 'KYBERN_BENCH_PERSISTED_IDLE']

export type WindowRow = {
  tag: string; round: number; arm: string; scenario: string; run: number; status: Result['status']; attempts: number; at: string
  frames: number | null; p95: number | null; over33: number | null; cpuPercent: number | null; gpuMs: number | null; footprintMiB: number | null
  sampleSeconds: number | null; wsCpuPercent: number | null; wsGpuMs: number | null; rate: number | null; appkit: boolean | null
  loadBefore: number; loadAfter: number; battery: string
}

const args = process.argv.slice(2)
const opt = (name: string, fallback?: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1]! : fallback }
const parse = () => {
  const out = opt('out'); if (!out) throw Error('usage: bun perf/bench/gate2.ts --out <file.jsonl> [--rounds 4] [--seed n] [--arms a,b] [--scenarios s,t] [--tag name] [--no-warmup]')
  return {
    out: path.resolve(out), rounds: Number(opt('rounds', '4')), seed: Number(opt('seed', '20261022')), tag: opt('tag', 'primary')!,
    arms: opt('arms', 'window,sidebar,solid,solid-aa')!.split(','), scenarios: opt('scenarios', 'streaming,thread-scroll,sidebar-scroll,idle-home')!.split(','),
    warmup: !args.includes('--no-warmup'), fresh: args.includes('--fresh'),
  }
}

const loadAverage = () => Number(execFileSync('sysctl', ['-n', 'vm.loadavg'], {encoding: 'utf8'}).trim().replace(/[{}]/g, '').trim().split(/\s+/)[0])
const battery = () => execFileSync('pmset', ['-g', 'batt'], {encoding: 'utf8'}).split('\n').map(l => l.trim()).filter(Boolean).join(' | ')
/** True when macOS reports a recorded thermal or CPU speed limit. `pmset -g therm` prints `CPU_Speed_Limit = 100` when throttled state exists. */
export function thermalLimited(text: string) {
  const speed = text.match(/CPU_Speed_Limit\s*=\s*(\d+)/), scheduler = text.match(/Scheduler_Limit\s*=\s*(\d+)/)
  return (speed != null && Number(speed[1]) < 100) || (scheduler != null && Number(scheduler[1]) < 100)
}
async function coolEnough(log: (m: string) => void) {
  for (let waited = 0; waited <= 600; waited += 30) {
    const text = execFileSync('pmset', ['-g', 'therm'], {encoding: 'utf8'})
    if (!thermalLimited(text)) return
    log(`thermally limited, waiting 30 s: ${text.replace(/\n/g, ' ')}`); await Bun.sleep(30000)
  }
  throw Error('Thermally limited for ten minutes; aborting rather than measuring throttled hardware')
}

const settings = import.meta.main ? parse() : null
if (settings) {
  const {out, rounds, seed, tag, arms, scenarios, warmup, fresh} = settings
  const app = path.resolve(import.meta.dir, '../..'); process.chdir(app)
  for (const arm of arms) if (!ARMS[arm]) throw Error(`Unknown arm ${arm}; arms: ${Object.keys(ARMS).join(', ')}`)
  const data = process.env.KYBERN_DATA_DIR; if (!data || !data.includes('scratch')) throw Error('Set KYBERN_DATA_DIR to a scratch directory')
  const scratch = path.join(path.dirname(data), `gate2-work-${path.basename(out, '.jsonl')}`); mkdirSync(scratch, {recursive: true})
  const logFile = path.join(scratch, 'gate2.log')
  const log = (m: string) => { const line = `[${new Date().toISOString()}] ${m}\n`; process.stdout.write(line); appendFileSync(logFile, line) }
  const done = new Set<string>(existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean).map(l => { const r = JSON.parse(l) as WindowRow; return `${r.tag}|${r.round}|${r.arm}|${r.scenario}` }) : [])
  const passes = plan(arms, scenarios, rounds, seed)
  // Round 0 is the throw-away warm-up: the first block of a session lands in a quieter regime than the rest.
  if (warmup && !done.has(`${tag}|0|${arms.find(a => a.startsWith('solid')) ?? arms[0]}|${scenarios[0]}`)) passes.unshift({round: 0, arm: arms.find(a => a.startsWith('solid')) ?? arms[0]!, scenarios: [...scenarios]})
  log(`gate2 tag=${tag} seed=${seed} rounds=${rounds} arms=${arms} scenarios=${scenarios}`)
  log(`schedule: ${passes.map(p => `r${p.round}:${p.arm}[${p.scenarios.join(',')}]`).join(' ')}`)
  const started = performance.now()
  for (const pass of passes) {
    await coolEnough(log)
    for (const scenario of pass.scenarios) {
      const key = `${tag}|${pass.round}|${pass.arm}|${scenario}`
      if (done.has(key)) continue
      const idle = scenario.startsWith('idle-'), label = `g2-${tag}-r${pass.round}-${pass.arm}-${scenario}`.replace(/[^a-zA-Z0-9_.-]/g, '-')
      const env: Record<string, string | undefined> = {...process.env, ...Object.fromEntries(PINNED.map(k => [k, undefined])), ...ARMS[pass.arm], KYBERN_BENCH_WINDOWSERVER: '1', KYBERN_FULL_RATE: '1', KYBERN_BENCH_EVIDENCE: path.join(scratch, 'evidence'), ...(idle ? {KYBERN_BENCH_PERSISTED_IDLE: '1'} : {})}
      for (const k of PINNED) if (env[k] === undefined) delete env[k]
      const resultFile = path.join(app, 'perf/bench/results', `${label}.json`)
      let rows: WindowRow[] = [], attempts = 0
      const loadBefore = loadAverage(), batt = battery()
      while (attempts < 2) {
        attempts++
        rmSync(resultFile, {force: true})
        const child = Bun.spawn(['bun', 'perf/bench/run.ts', scenario, '--runs', '3', '--label', label, ...(fresh ? [] : ['--keep-data']), ...(idle ? ['--warmup', '20'] : [])], {env: env as Record<string, string>, stdout: 'pipe', stderr: 'pipe'})
        const timer = setTimeout(() => child.kill(), 420000)
        const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
        const code = await child.exited; clearTimeout(timer)
        writeFileSync(path.join(scratch, `${label}-attempt-${attempts}.log`), `${stdout}\n--- stderr ---\n${stderr}`)
        let doc: {results: Result[]; aborted?: boolean} | null = null
        try { doc = JSON.parse(readFileSync(resultFile, 'utf8')) } catch { /* the run died before saving */ }
        const all = doc?.results ?? [], results = all.filter(r => r.status !== 'discarded') // run.ts queues a discarded window again itself
        rows = results.map(r => ({
          tag, round: pass.round, arm: pass.arm, scenario, run: r.run, status: r.status, attempts, at: new Date().toISOString(),
          frames: r.frames.count, p95: r.frames.p95, over33: r.frames.over33, cpuPercent: r.resources.cpuPercent, gpuMs: r.resources.gpuMs, footprintMiB: r.resources.footprintMiB,
          sampleSeconds: r.resources.sampleSeconds, wsCpuPercent: r.resources.windowServer?.cpuPercent ?? null, wsGpuMs: r.resources.windowServer?.gpuMs ?? null,
          rate: (r.evidence.offeredPacketsPerSecond ?? r.evidence.offeredDeltasPerSecond ?? null) as number | null, appkit: (r.evidence.appkitAccepted ?? null) as boolean | null,
          loadBefore, loadAfter: loadAverage(), battery: batt,
        }))
        log(`${key} exit=${code} attempt=${attempts} statuses=${results.map(r => r.status).join(',') || 'none'} discarded=${all.length - results.length}`)
        if (!doc?.aborted && rows.length === 3 && rows.every(r => r.status === 'ok')) break
      }
      appendFileSync(out, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
      rmSync(resultFile, {force: true}); rmSync(resultFile.replace(/\.json$/, '.md'), {force: true})
      done.add(key)
    }
    log(`pass r${pass.round} ${pass.arm} finished; ${((performance.now() - started) / 60000).toFixed(1)} min elapsed`)
  }
  log('gate2 complete')
}
