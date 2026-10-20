// Rings that ease between values (N2: stroke_draw.rs `from`/`to`/`retarget`, `ringValue`) in dark, light and Reduce Motion.
// On the paused automation clock, OS window captures count the ring's ink: it mounts at its value (equal to the same value
// drawn as its own arc path), a new value eases from the old one monotonically, a value changed mid-tween continues from
// where the arc is (no restart from empty), a re-render keeps the value, and `drawIn` strokes it in from empty. Reduce
// Motion lands at once. On the live clock a change presents display-rate frames without renders and none once it rests.
import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { launchFixture } from '../src/tasks/round7b-harness.ts'
import { assertNonBlackContent, pngPixels } from './clip-pixels.ts'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? path.join(import.meta.dir, 'build/ring'); mkdirSync(out, { recursive: true })
const scratch = { KYBERN_DATA_DIR: process.env.KYBERN_DATA_DIR ?? '/Users/mymac/projects/ade-gpuix-scratch/motion-native/lab', KYBERN_CLIENT_CONFIG_DIR: process.env.KYBERN_CLIENT_CONFIG_DIR ?? '/Users/mymac/projects/ade-gpuix-scratch/motion-native/lab-client', KYBERN_URL: '', KYBERN_TOKEN: '' }
if (path.resolve(scratch.KYBERN_DATA_DIR) === '/Users/mymac/.kybern') throw Error('Refusing the real data dir')
const W = 320, H = 140
const results: unknown[] = []
for (const [label, env] of [['dark', {}], ['light', { KYBERN_APPEARANCE: 'light' }], ['reduced', { KYBERN_REDUCED_MOTION: '1' }]] as const) {
  const log = path.join(out, `${label}.log`); rmSync(log, { force: true }); process.env.R7_LOG = log
  const all = () => { try { return readFileSync(log, 'utf8') } catch { return '' } }
  const f = await launchFixture(path.join(import.meta.dir, 'ring-lab.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark', KYBERN_FULL_RATE: '1', KYBERN_FRAME_COSTS: '1', KYBERN_FRAME_TIMES: '1', ...scratch, ...env })
  try {
    const a = f.app; await a.getByTestId('app-ready').waitFor()
    await a.call('focus', { elementId: (await a.getByTestId('app-ready').element()).id })
    const key = async (k: string) => { await a.call('keyDown', { key: k }) }
    const wait = async (check: () => Promise<boolean> | boolean, name: string) => { const deadline = Date.now() + 6000; while (!await check()) { assert.ok(Date.now() < deadline, name); await Bun.sleep(10) } }
    const count = (pattern: RegExp) => (all().match(pattern) ?? []).length
    const settle = async () => { let last = all().length, quiet = performance.now(); await wait(() => { const n = all().length; if (n !== last) { last = n; quiet = performance.now() } return performance.now() - quiet > 250 }, 'settled') }
    const windowId = execFileSync('swift', [path.join(import.meta.dir, '../src/tasks/round7-window-id.swift'), String(f.pid)], { encoding: 'utf8' }).trim()
    // Ink of the ring (left) and the reference arc (right): pixels that differ from the background.
    const ink = async (name: string) => {
      await Bun.sleep(100)
      const file = path.join(out, `${label}-${name}.png`)
      for (let attempt = 0; ; attempt++) {
        execFileSync('screencapture', ['-x', '-o', '-l', windowId, file])
        try { assertNonBlackContent(file, W, H, `${label}-${name}`); break }
        catch (error) { copyFileSync(file, file.replace(/\.png$/, `-rejected-${attempt}.png`)); if (attempt >= 5) throw error; await Bun.sleep(300) }
      }
      const img = pngPixels(file), sc = img.width / W, top = img.height / sc - H, bg = img.at(4 * sc, (top + 4) * sc)
      const box = (x0: number) => { let n = 0; for (let y = Math.round((top + 20) * sc); y < (top + 116) * sc; y++) for (let x = Math.round(x0 * sc); x < (x0 + 96) * sc; x++) if (img.at(x, y).some((v, i) => Math.abs(v - bg[i]!) > 40)) n++; return n }
      return { ring: box(20), plain: box(140) }
    }
    await settle()
    const start = await ink('mount')
    assert.ok(Math.abs(start.ring - start.plain) <= start.plain * 0.06 + 20, `${label}: the ring did not mount at its value (${start.ring} vs ${start.plain})`)
    await a.clock.pause()
    const steps: number[] = []
    let at = 0
    const step = async (name: string, offsets: number[]) => { for (const o of offsets) { if (o > at) await a.clock.fastForward(o - at); at = o; steps.push((await ink(`${name}-${o}`)).ring) } }
    await key('5'); await Bun.sleep(80); at = 0
    await step('to50', [0, 60, 140])
    // Retarget mid-tween: continue from the arc on screen towards 90 %.
    await key('9'); await Bun.sleep(80); at = 0
    await step('to90', [0, 100, 450])
    await a.clock.resume()
    const end = await ink('end90')
    assert.ok(Math.abs(end.ring - end.plain) <= end.plain * 0.06 + 20, `${label}: the ring did not rest at 90 % (${end.ring} vs ${end.plain})`)
    await key('t'); await a.getByText('Tick 1').waitFor(); await settle()
    const kept = await ink('rerender')
    assert.ok(Math.abs(kept.ring - end.ring) <= end.ring * 0.03 + 10, `${label}: a re-render moved the ring (${end.ring} -> ${kept.ring})`)
    if (label !== 'reduced') {
      assert.ok(steps[0]! < steps[2]! && steps[1]! > start.ring - 20 && steps[1]! < steps[2]! + 20, `${label}: 25 -> 50 % did not ease (${start.ring}, ${steps.slice(0, 3)})`)
      assert.ok(steps[2]! < end.plain * 0.75, `${label}: the 50 % leg ran to its end before the retarget (${steps})`)
      assert.ok(steps[3]! >= steps[2]! - 30, `${label}: the retarget restarted from empty (${steps})`)
      for (let i = 4; i < steps.length; i++) assert.ok(steps[i]! >= steps[i - 1]! - 30, `${label}: the ring went backwards (${steps})`)
    } else {
      assert.ok(Math.abs(steps[0]! - steps[2]!) <= steps[2]! * 0.05 + 20, `${label}: Reduce Motion eased (${steps})`)
    }
    // Draw-in from empty, then the live clock: frames without renders while it eases, none at rest.
    await key('1'); await settle()
    const frames0 = count(/\[kybern-submit\]/g), renders0 = count(/\[kybern-work\]/g)
    await key('9'); await Bun.sleep(600)
    const frames = count(/\[kybern-submit\]/g) - frames0, renders = count(/\[kybern-work\]/g) - renders0
    const idle0 = count(/\[kybern-submit\]/g); await Bun.sleep(600); const idle = count(/\[kybern-submit\]/g) - idle0
    if (label !== 'reduced') assert.ok(frames >= 15, `${label}: the change presented ${frames} frames`)
    assert.ok(renders <= 2, `${label}: the change rendered ${renders} times`)
    assert.equal(idle, 0, `${label}: frames at rest`)
    await a.clock.pause(); await key('d'); await Bun.sleep(80); at = 0
    const draw: number[] = []
    for (const o of [0, 120, 450]) { if (o > at) await a.clock.fastForward(o - at); at = o; draw.push((await ink(`draw-${o}`)).ring) }
    await a.clock.resume()
    if (label !== 'reduced') assert.ok(draw[0]! < draw[2]! * 0.3 && draw[1]! < draw[2]!, `${label}: drawIn did not stroke in from empty (${draw})`)
    const result = { label, mount: start, steps, end, kept: kept.ring, frames, renders, idle, draw }
    results.push(result)
    console.log(`ok ${label}: mount ${start.ring}/${start.plain}; 25->50->90 ${steps}; rest ${end.ring}/${end.plain}; re-render ${kept.ring}; live ${frames} frames, ${renders} renders, ${idle} at rest; draw-in ${draw}`)
  } catch (error) { console.error(all().split('\n').filter(l => !/\[kybern-(frame|submit|work)\]/.test(l)).slice(-30).join('\n')); throw error } finally { await f.close() }
}
writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2))
process.exit(0)
