// `paintAnimation: { kind: 'stroke' }` (stroke_draw.rs, stroke_draw_scene.rs) in four modes: the path strokes itself in
// on the automation clock (no ink during the delay, partial ink mid-draw, growing monotonically), a re-render mid-draw
// keeps its progress, the finished glyph equals a plain render of the same SVG pixel for pixel, the draw presents
// display-rate frames without renders, and frames stop once it has ended. Reduce Motion: `strokeDraw` omits the prop.
import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { launchFixture } from '../src/tasks/round7b-harness.ts'
import { pngPixels } from './clip-pixels.ts'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? path.join(import.meta.dir, 'build/stroke-draw'); mkdirSync(out, { recursive: true })
const scratch = { KYBERN_DATA_DIR: process.env.KYBERN_DATA_DIR ?? '/Users/mymac/projects/ade-gpuix-scratch/motion10', KYBERN_CLIENT_CONFIG_DIR: process.env.KYBERN_CLIENT_CONFIG_DIR ?? '/Users/mymac/projects/ade-gpuix-scratch/motion10-client', KYBERN_URL: '', KYBERN_TOKEN: '' }
if (path.resolve(scratch.KYBERN_DATA_DIR) === '/Users/mymac/.kybern') throw Error('Refusing the real data dir')
const quantile = (values: number[], q: number) => { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? NaN }
const results: unknown[] = []
for (const theme of ['dark', 'light']) for (const reduce of ['0', '1']) {
  const label = `${theme}-${reduce === '1' ? 'reduced' : 'normal'}`
  const log = path.join(out, `${label}.log`); rmSync(log, { force: true }); process.env.R7_LOG = log
  const all = () => { try { return readFileSync(log, 'utf8') } catch { return '' } }
  const f = await launchFixture(path.join(import.meta.dir, 'stroke-draw-lab.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: reduce, KYBERN_FULL_RATE: '1', KYBERN_FRAME_COSTS: '1', KYBERN_FRAME_TIMES: '1', ...scratch })
  try {
    const a = f.app; await a.getByTestId('app-ready').waitFor()
    await a.call('focus', { elementId: (await a.getByTestId('app-ready').element()).id })
    const key = async (k: string) => { await a.call('keyDown', { key: k }) }
    const wait = async (check: () => Promise<boolean> | boolean, name: string) => { const deadline = Date.now() + 6000; while (!await check()) { assert.ok(Date.now() < deadline, name); await Bun.sleep(10) } }
    const count = (pattern: RegExp) => (all().match(pattern) ?? []).length
    const settle = async () => { let last = all().length, quiet = performance.now(); await wait(() => { const n = all().length; if (n !== last) { last = n; quiet = performance.now() } return performance.now() - quiet > 250 }, 'settled') }
    const windowId = execFileSync('swift', [path.join(import.meta.dir, '../src/tasks/round7-window-id.swift'), String(f.pid)], { encoding: 'utf8' }).trim()
    // Ink: pixels in the glyph's box that differ from the background, from an OS capture of the window.
    const ink = async (name: string) => {
      await Bun.sleep(120)
      const file = path.join(out, `${label}-${name}.png`); execFileSync('screencapture', ['-x', '-o', '-l', windowId, file])
      const img = pngPixels(file), sc = img.width / 320, top = img.height / sc - 160, bg = img.at(20 * sc, (top + 20) * sc)
      let n = 0
      for (let y = (top + 40) * sc; y < (top + 88) * sc; y++) for (let x = 40 * sc; x < 88 * sc; x++) if (img.at(x, y).some((v, i) => Math.abs(v - bg[i]!) > 24)) n++
      return { n, img, sc, top }
    }
    await settle()
    // Frozen clock: step through the draw.
    await a.clock.pause()
    await key('d'); await a.getByTestId('glyph').waitFor()
    const steps: [number, number][] = []
    let at = 0
    for (const o of [0, 100, 160, 175, 190, 220, 300, 450]) {
      if (o > at) await a.clock.fastForward(o - at); at = o
      steps.push([o, (await ink(`draw-${o}`)).n])
      if (o === 175) {
        // A render mid-draw (an unrelated change) keeps the draw where it is.
        await key('t'); await a.getByText('Tick 1').waitFor()
        const again = (await ink('draw-175-rerender')).n
        assert.ok(Math.abs(again - steps.at(-1)![1]) <= Math.max(6, steps.at(-1)![1] * 0.05), `${label}: a re-render moved the draw (${steps.at(-1)![1]} -> ${again})`)
      }
    }
    await a.clock.resume()
    const final = await ink('final')
    await key('p'); await a.getByTestId('glyph').waitFor(); await settle()
    const plain = await ink('plain')
    let differ = 0
    for (let y = (final.top + 40) * final.sc; y < (final.top + 88) * final.sc; y++) for (let x = 40 * final.sc; x < 88 * final.sc; x++) { const p = final.img.at(x, y), q = plain.img.at(x, y); if (p.some((v, i) => Math.abs(v - q[i]!) > 3)) differ++ }
    assert.ok(differ < 4, `${label}: the finished draw differs from a plain render (${differ} px)`)
    const whole = plain.n
    if (reduce === '0') {
      assert.ok(steps[0]![1] < whole * 0.05 && steps[1]![1] < whole * 0.05, `${label}: ink during the delay (${steps.map(s => s[1]).join(', ')})`)
      const mid = steps.find(s => s[0] === 160)![1]
      assert.ok(mid > whole * 0.05 && mid < whole * 0.8, `${label}: 10 ms into the draw is not partial (${mid} of ${whole})`)
      for (let i = 1; i < steps.length; i++) assert.ok(steps[i]![1] >= steps[i - 1]![1] - 6, `${label}: the draw went backwards (${steps.map(s => s[1]).join(', ')})`)
      assert.ok(Math.abs(steps.at(-1)![1] - whole) <= Math.max(6, whole * 0.03), `${label}: the draw did not end whole`)
    } else {
      for (const [o, n] of steps) assert.ok(Math.abs(n - whole) <= Math.max(6, whole * 0.03), `${label}: Reduce Motion drew (${o} ms: ${n} of ${whole})`)
    }
    // Live clock: display-rate frames and no renders while it draws; nothing once it has ended.
    await settle()
    const frames0 = count(/\[kybern-submit\]/g), renders0 = count(/\[kybern-work\]/g), start = all().length
    await key('d'); await Bun.sleep(500)
    const tail = all().slice(start).match(/\[kybern-submit\] ([\d.]+)/g)?.map(l => Number(l.split(' ')[1])) ?? []
    const intervals = tail.slice(1).map((t, i) => t - tail[i]!).filter(d => d < 100)
    const frames = count(/\[kybern-submit\]/g) - frames0, renders = count(/\[kybern-work\]/g) - renders0
    const idle0 = count(/\[kybern-submit\]/g); await Bun.sleep(600); const idle = count(/\[kybern-submit\]/g) - idle0
    if (reduce === '0') assert.ok(frames >= 20, `${label}: the draw presented ${frames} frames`)
    assert.ok(renders <= 2, `${label}: the draw rendered ${renders} times (the mount and the key)`)
    assert.equal(idle, 0, `${label}: frames after the draw ended`)
    const result = { label, steps, whole, frames, renders, idle, p50: quantile(intervals, 0.5), p95: quantile(intervals, 0.95) }
    results.push(result)
    console.log(`ok ${label}: ink ${steps.map(s => `${s[0]}ms=${s[1]}`).join(' ')} (whole ${whole}); re-render keeps progress; end = plain render; live draw ${frames} frames, ${renders} renders, p50 ${result.p50?.toFixed(1)} ms, p95 ${result.p95?.toFixed(1)} ms; ${idle} frames after it ended (KYBERN_FULL_RATE=1)`)
  } catch (error) { console.error(all().split('\n').filter(l => !/\[kybern-(frame|submit|work)\]/.test(l)).slice(-30).join('\n')); throw error } finally { await f.close() }
}
writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2))
process.exit(0)
