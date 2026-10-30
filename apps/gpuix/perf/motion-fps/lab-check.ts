/** Compositor loops end to end in perf/motion-fps/lab.tsx (one UI lease, hidden test display, no daemon):
 *   1. settled loops present no app frames and every loop part has a Core Animation layer,
 *   2. layers follow the native curves: matrix/breathe/shimmer opacity, clockwise turns at the cycle rate,
 *   3. sprite masks are upright (the glyphs' ink is where the scene draws it),
 *   4. a box painted over loaders hands them back to scene painting (60 Hz frames) and back again once removed,
 *   5. a layout shift moves the layers, and unmounting removes them with no frames afterwards.
 *
 *   bun perf/motion-fps/lab-check.ts [--light] [--reduced]
 * With KYBERN_COMPOSITOR_LOOPS=0 it asserts the scene path instead (display-rate frames, no layers). */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../../src/requests/harness.ts'
import { lease } from '../bench/lease.ts'

const light = process.argv.includes('--light'), reduced = process.argv.includes('--reduced')
const compositor = process.env.KYBERN_COMPOSITOR_LOOPS !== '0'
const mode = `${light ? 'light' : 'dark'}${reduced ? '-reduced' : ''}${compositor ? '' : '-scene'}`
const out = path.join(process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/previews/motion/fps/lab', mode)
const scratch = process.env.KYBERN_MOTION_SCRATCH ?? '/Users/mymac/projects/ade-gpuix-scratch/motion-fps/lab-scratch'
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true }); mkdirSync(scratch, { recursive: true })
type Probe = { layers: { frame: string; color: number[]; radius: number; ink: { top: number; bottom: number; left: number; right: number; rows: string[] } | null }[]; samples: { t: number; opacity: number[]; angle: number[]; lum: number[] }[] }
const release = await lease()
const f = await launchFixture(path.join(import.meta.dir, 'lab.tsx'), {
  KYBERN_DATA_DIR: scratch, KYBERN_URL: '', KYBERN_CLIENT_CONFIG_DIR: path.join(scratch, 'client'), GPUIX_BACKGROUND: '1', KYBERN_FRAME_TIMES: '1',
  // The shell running this may carry the installed app's addon path; always load this checkout's build.
  NAPI_RS_NATIVE_LIBRARY_PATH: path.resolve(import.meta.dir, `../../native/build/gpuix-native.darwin-${process.arch}.node`), MOTION_LAB_OUT: out, KYBERN_APPEARANCE: light ? 'light' : 'dark', ...(reduced ? { KYBERN_REDUCED_MOTION: '1' } : {}),
})
const a = f.app, sleep = (ms: number) => Bun.sleep(ms)
const frames = async (ms: number) => { const n = f.frameTimes().length; await sleep(ms); return f.frameTimes().length - n }
let probes = 0
const probe = async (): Promise<Probe> => {
  const n = ++probes, file = path.join(out, `${n}.json`)
  await a.getByTestId('app-ready').press('x')
  for (let i = 0; i < 200 && !existsSync(file); i++) await sleep(25)
  await sleep(50)
  return JSON.parse(readFileSync(file, 'utf8'))
}
const results: Record<string, unknown> = { mode }
try {
  await a.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  await a.getByTestId('app-ready').click()
  await sleep(1500)
  const settled = await frames(2000)
  const p = await probe()
  results.settled = { frames: settled, layers: p.layers.length, masked: p.layers.filter(l => l.ink).length }
  if (reduced) {
    assert.equal(settled, 0, 'Reduce Motion: loops are still')
    assert.equal(p.layers.length, 0, 'Reduce Motion: no compositor layers')
  } else if (!compositor) {
    assert.ok(settled > 100, `scene path presents at display rate (${settled} frames in 2 s)`)
    assert.equal(p.layers.length, 0, 'scene path: no compositor layers')
  } else {
    assert.ok(settled <= 2, `settled compositor loops present no app frames (${settled} in 2 s)`)
    // 12 orbit + 12 pulse + 16 scan + 16 twinkle dots, task pie, connection arc, kit spinner, "Thinking" glyphs.
    assert.ok(p.layers.length >= 56 + 3 + 8, `every loop part has a layer (${p.layers.length})`)
    // Curves: opacity stays within each loop's range; spinners turn clockwise (negative angles) at their cycle rate.
    const spins = p.layers.map((_, i) => i).filter(i => p.samples.some(s => Math.abs(s.angle[i]!) > 0.01))
    assert.equal(spins.length, 2, 'connection arc and kit spinner rotate')
    for (const i of spins) {
      // Presentation values step with the compositor's frame clock, so use the unwrapped total turn over the window.
      const turns = p.samples.slice(1).map((s, k) => { let d = s.angle[i]! - p.samples[k]!.angle[i]!; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; return d })
      const rate = turns.reduce((x, y) => x + y, 0) / (p.samples.at(-1)!.t - p.samples[0]!.t) * 1000 / (2 * Math.PI)
      assert.ok(turns.every(d => d <= 1e-6), 'spinners only turn clockwise')
      results[`spin${i}`] = rate
      assert.ok(Math.abs(rate + 1) < 0.05 || Math.abs(rate + 1 / 1.3) < 0.05, `spinner rate ${rate} turns/s (1 s or 1.3 s cycles)`)
    }
    const lows = p.layers.map((_, i) => Math.min(...p.samples.map(s => s.opacity[i]!))), highs = p.layers.map((_, i) => Math.max(...p.samples.map(s => s.opacity[i]!)))
    results.opacity = { min: Math.min(...lows), max: Math.max(...highs) }
    assert.ok(Math.min(...lows) >= 0.2 && Math.max(...highs) <= 1.0001, 'opacity stays in the curves\' range')
    // The shimmer band (N4): each "Thinking" glyph's colour moves towards the foreground once per 2 s cycle, the
    // leftmost glyph first and the rightmost about a third of the cycle later (a sweep, not a pulse).
    const banded = p.layers.map((l, i) => ({ x: Number(l.frame.match(/-?[\d.]+/g)![0]), lums: p.samples.map(s => s.lum[i]!) }))
      .filter(b => Math.max(...b.lums) - Math.min(...b.lums) > 0.1).sort((x, y) => x.x - y.x)
    // The band's peak is the sample furthest from the glyph's rest colour (it lightens in dark, darkens in light).
    const peak = (b: { lums: number[] }) => { const rest = [...b.lums].sort((x, y) => x - y)[b.lums.length >> 1]!, off = b.lums.map(v => Math.abs(v - rest)); return p.samples[off.indexOf(Math.max(...off))]!.t }
    const lag = banded.length ? (((peak(banded.at(-1)!) - peak(banded[0]!)) % 2000) + 2000) % 2000 : -1
    results.band = { glyphs: banded.length, lagMs: Math.round(lag) }
    assert.ok(banded.length >= 6, `the shimmer band crosses every glyph (${banded.length} banded layers)`)
    assert.ok(lag > 60 && lag < 1000, `the band sweeps left to right (rightmost glyph peaks ${Math.round(lag)} ms after the leftmost)`)
    // Masks upright: the "T" of "Thinking" carries its bar at the top.
    const glyphs = p.layers.filter(l => l.ink && l.ink.rows.length > 16 && l.ink.rows.length < 30)
    const tee = glyphs.find(l => l.ink!.rows[1]!.replace(/\./g, '').length > l.ink!.rows[1]!.length * 0.6)
    assert.ok(tee && tee.ink!.top > tee.ink!.bottom * 1.5, 'glyph masks are upright')
    results.tee = tee?.ink?.rows
    // Occlusion: covered loaders go back to the scene (display-rate frames); the rest stay composited.
    await a.getByTestId('app-ready').press('o'); await sleep(300)
    const covered = await frames(1000), q = await probe()
    results.covered = { frames: covered, layers: q.layers.length }
    assert.ok(covered > 40, `covered loops animate in the scene (${covered} frames/s)`)
    assert.ok(q.layers.length < p.layers.length && q.layers.length > 0, 'only the covered loops leave the compositor')
    await a.getByTestId('app-ready').press('o'); await sleep(500)
    const uncovered = await frames(1500), r = await probe()
    results.uncovered = { frames: uncovered, layers: r.layers.length }
    assert.ok(uncovered <= 2 && r.layers.length === p.layers.length, 'uncovered loops return to the compositor')
    // Layout shift: layers move by 12 pt.
    const x0 = Math.min(...r.layers.map(l => Number(l.frame.match(/-?[\d.]+/g)![0])))
    await a.getByTestId('app-ready').press('g'); await sleep(500)
    const s = await probe(), x1 = Math.min(...s.layers.map(l => Number(l.frame.match(/-?[\d.]+/g)![0])))
    results.shift = x1 - x0
    assert.ok(Math.abs(x1 - x0 - 12) < 0.01 && s.layers.length === p.layers.length, `layers follow layout (moved ${x1 - x0})`)
    // Unmount: no layers, no frames.
    await a.getByTestId('app-ready').press('h'); await sleep(300)
    const gone = await frames(1500), t = await probe()
    results.unmounted = { frames: gone, layers: t.layers.length }
    assert.ok(gone <= 1 && t.layers.length === 0, 'unmounted loops leave nothing behind')
  }
  console.log(`PASS compositor loops (${mode}) ${JSON.stringify({ ...results, tee: undefined })}`)
} finally {
  await f.close(); release(); rmSync(scratch, { recursive: true, force: true })
}
