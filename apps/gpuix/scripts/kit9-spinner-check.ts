/**
 * R4-3: running CI checks spin natively. Opens the PR page against the in-memory PR fixture (`src/pulls/verify.fixture.ts`,
 * no GitHub, no real daemon) with one or several running checks and checks, with real window pixels:
 *   1. the glyph turns (frames a few ms apart differ) and completes a full turn in 1000 ms (frame t and t+1000 match),
 *   2. presented-frame intervals while it spins (p50/p95; KYBERN_FRAME_TIMES, no screenshots in the interval),
 *   3. Reduce Motion: still, and no frames presented,
 *   4. `--resources`: 10 s warm-up, then a 15 s CPU / footprint / GPU sample (perf/sample.ts).
 *
 *   bun scripts/kit9-spinner-check.ts [--light] [--reduced] [--running N] [--resources]
 */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../src/requests/harness.ts'
import { guardEnv } from './kit9-lib.ts'
import { actionFixture } from '../src/pulls/verify.fixture.ts'
import { pixels } from '../native/png.ts'

const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined)
const minimized = process.argv.includes('--minimize')  // minimize the window mid-run (SIGUSR1): the glyph must stop, and start again on restore
const light = process.argv.includes('--light'), reduced = process.argv.includes('--reduced'), resources = process.argv.includes('--resources')
const extra = Number(arg('--running') ?? 0)
const theme = light ? 'light' : 'dark'
const dir = '/Users/mymac/projects/ade/previews/gpuix/phase2/kit9/spinner'
mkdirSync(dir, { recursive: true })
const label = `${theme}${reduced ? '-reduced' : ''}${minimized ? '-minimized' : ''}-${extra + 1}running`
const fixture = actionFixture({ running: extra })
const f = await launchFixture(path.join(import.meta.dir, 'kit9-app.ts'), guardEnv({ ...fixture.env, KYBERN_APPEARANCE: theme, KYBERN_FRAME_TIMES: '1', ...(reduced ? { KYBERN_REDUCED_MOTION: '1' } : {}) }))
const a = f.app
const sleep = (n: number) => new Promise((r) => setTimeout(r, n))
const pct = (xs: number[], p: number) => xs[Math.floor(xs.length * p)] ?? NaN
try {
  await a.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  await a.getByTestId('rail-pulls').click()
  await a.getByTestId('pr-row-108').waitFor({ timeoutMs: 15_000 })
  await a.getByTestId('pr-row-108').click()
  await a.getByTestId('pr-summary').waitFor({ timeoutMs: 15_000 })
  await sleep(1500)
  const spinners = await a.getByTestId('pr-check-spinner').count()
  assert.equal(spinners, extra + 1, `expected ${extra + 1} running-check spinners, found ${spinners}`)
  assert.equal(await a.getByTestId('pr-checks-spinner').count(), 1, 'the Checks summary spins while any check runs')
  const first = (await a.getByTestId('pr-check-spinner').all())[0]!.bounds!
  console.log(`running checks spinning: ${spinners} + summary; first glyph at ${JSON.stringify(first)}`)

  const hide = async () => { process.kill(f.pid, 'SIGUSR1'); await sleep(1500) }
  const show = async () => { process.kill(f.pid, 'SIGUSR2'); await sleep(1500) }
  if (minimized && !resources) {
    await hide()
    let mark = f.frameTimes().at(-1) ?? 0
    await sleep(3000)
    const hiddenFrames = f.frameTimes().filter((t) => t > mark).length
    console.log(`minimized: ${hiddenFrames} frames presented in 3 s`)
    assert(hiddenFrames <= 3, `a minimized window must not keep presenting frames (${hiddenFrames})`)
    await show()
    mark = f.frameTimes().at(-1) ?? 0
    await sleep(2000)
    const back = f.frameTimes().filter((t) => t > mark).length
    const after = f.frameTimes().filter((t) => t > mark), gaps = after.slice(1).map((t, i) => t - after[i]!).sort((x, y) => x - y)
    console.log(`restored: ${back} frames in 2 s, first after ${(after[0]! - mark).toFixed(0)} ms, interval p50 ${pct(gaps, 0.5).toFixed(1)} p95 ${pct(gaps, 0.95).toFixed(1)}`)
    assert(back > 60, `the spinner must resume on restore (${back} frames)`)
    console.log(`PASS ${label}`)
  } else if (!resources) {
    // 2. Frame cadence while spinning (no screenshots or tree reads in the interval).
    const mark = f.frameTimes().at(-1) ?? 0
    await sleep(3000)
    const frames = f.frameTimes().filter((t) => t > mark)
    const dt = frames.slice(1).map((t, i) => t - frames[i]!).sort((x, y) => x - y)
    console.log(`frames in 3 s (${label}): ${frames.length}, interval p50 ${pct(dt, 0.5).toFixed(2)} ms, p95 ${pct(dt, 0.95).toFixed(2)} ms`)
    // A settled spinner runs in Core Animation (compositor loops): the app presents nothing while it turns. The scene path
    // (`KYBERN_COMPOSITOR_LOOPS=0`) presents at display rate.
    const scene = process.env.KYBERN_COMPOSITOR_LOOPS === '0'
    if (reduced) assert(frames.length <= 3, `Reduce Motion must not keep presenting frames (${frames.length})`)
    else if (scene) assert(frames.length > 120, `a spinning glyph must present continuous frames (${frames.length})`)
    else assert(frames.length <= 3, `a settled spinner runs in Core Animation and presents no app frames (${frames.length})`)

    // 1. Pixels. The native animation runs on the real clock, so each phase is a separate launch with the phase frozen
    // (`KYBERN_PAINT_PHASE_MS`, the native checks' own mechanism). The glyph has eight-fold symmetry: 125 ms is exactly
    // 45 degrees and looks like 0, so 40 ms (14.4 degrees) must differ while 45-degree multiples (125, 1000, 1125 ms) match.
    const region = (file: string, box: { x: number; y: number; width: number; height: number }) => {
      const img = pixels(file), scale = img.w / 1280
      const out: number[] = []
      for (let y = Math.floor((box.y - 1) * scale); y < Math.ceil((box.y + box.height + 1) * scale); y++) for (let x = Math.floor((box.x - 1) * scale); x < Math.ceil((box.x + box.width + 1) * scale); x++) out.push(...img.at(x, y).slice(0, 3))
      return out
    }
    const shots: Record<number, string> = {}
    for (const phase of [0, 40, 125, 1000, 1125]) {
      const g = await launchFixture(path.join(import.meta.dir, 'kit9-app.ts'), guardEnv({ ...fixture.env, KYBERN_APPEARANCE: theme, KYBERN_PAINT_PHASE_MS: String(phase), ...(reduced ? { KYBERN_REDUCED_MOTION: '1' } : {}) }))
      try {
        await g.app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
        await g.app.getByTestId('rail-pulls').click()
        await g.app.getByTestId('pr-row-108').waitFor({ timeoutMs: 15_000 })
        await g.app.getByTestId('pr-row-108').click()
        await g.app.getByTestId('pr-summary').waitFor({ timeoutMs: 15_000 })
        await sleep(1500)
        shots[phase] = `${dir}/${label}-${String(phase).padStart(4, '0')}.png`
        // The presented frame, from WindowServer: the automation screenshot re-renders the scene without the per-present
        // rotation, so every frozen phase would look the same in it.
        const id = /window (\d+) onscreen=true/.exec(Bun.spawnSync(['swift', path.join(import.meta.dir, '../perf/bench/window-onscreen.swift'), String(g.pid)]).stdout.toString())?.[1]
        assert.ok(id, 'the frozen-phase window is not on screen')
        assert.equal(Bun.spawnSync(['screencapture', '-x', '-o', '-l', id, shots[phase]]).exitCode, 0, 'window capture failed')
      } finally { await g.close() }
    }
    const diff = (x: number, y: number) => { const A = region(shots[x]!, first), B = region(shots[y]!, first); let s = 0; for (let i = 0; i < A.length; i++) s += Math.abs(A[i]! - B[i]!); return s }
    const d = { '0→40': diff(0, 40), '0→125': diff(0, 125), '0→1000': diff(0, 1000), '125→1125': diff(125, 1125), '0→1125': diff(0, 1125) }
    console.log('glyph pixel difference between frozen phases:', JSON.stringify(d))
    if (reduced) assert.equal(d['0→40'], 0, 'Reduce Motion: the glyph must stay still')
    else assert(d['0→40'] > 8 * Math.max(d['0→125'], d['0→1000'], d['125→1125'], 1), 'the glyph must be a different phase at 40 ms and match at 125/1000/1125 ms: a 1000 ms linear turn')
    // A zoomed strip of the glyph (60 x 60 pt around it) for the report.
    const H = import.meta.dir, scale = 2
    const crops = Object.entries(shots).map(([o, file]) => { const c = `${dir}/c-${label}-${String(o).padStart(4, '0')}.png`; Bun.spawnSync(['swift', `${H}/kit9-crop.swift`, file, c, String(Math.round((first.x - 23) * scale)), String(Math.round((first.y - 23) * scale)), String(60 * scale), String(60 * scale)]); return c })
    Bun.spawnSync(['swift', `${H}/kit9-strip.swift`, `${dir}/strip-${label}.png`, '120', `${label}=${crops.join(',')}`])
    console.log(`PASS ${label}`)
  } else {
    // 4. Resources: warm up, then sample. No screenshots or automation calls in the interval.
    if (minimized) await hide()
    await sleep(10_000)
    const proc = Bun.spawn(['bun', path.join(import.meta.dir, '../perf/sample.ts'), '15', `GPUIX=${f.pid}`], { stdout: 'pipe', stderr: 'pipe' })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    console.log(`resources (${label}, KYBERN_FULL_RATE default, 10 s warm-up, 15 s sample, window visible at floating level):\n${out.trim()}`)
  }
} finally {
  await f.close()
  fixture.close()
}
