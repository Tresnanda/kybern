// Paint-only hover colour fades (N1: hover_fade_window.rs, hover_fade_scene.rs, hover_fade.rs) in dark, light, Reduce
// Motion (colour is not motion: it still fades) and the `KYBERN_HOVER_FADE=0` control (snaps). On the paused automation
// clock, OS window captures step a hover in and out: the fill (and a border colour, and a fill inside a retained
// `paintTransform`) moves monotonically from rest to hover and back; an opt-out (`hoverTransition={false}`), a rest colour
// changed by state, and a press land at once; the release eases back. On the live clock a hover renders once (the flip),
// presents display-rate frames without renders while it fades, and stops presenting when it ends.
import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { launchFixture } from '../src/tasks/round7b-harness.ts'
import { assertNonBlackContent, pngPixels } from './clip-pixels.ts'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? path.join(import.meta.dir, 'build/hover-fade'); mkdirSync(out, { recursive: true })
const scratch = { KYBERN_DATA_DIR: process.env.KYBERN_DATA_DIR ?? '/Users/mymac/projects/ade-gpuix-scratch/motion-native/lab', KYBERN_CLIENT_CONFIG_DIR: process.env.KYBERN_CLIENT_CONFIG_DIR ?? '/Users/mymac/projects/ade-gpuix-scratch/motion-native/lab-client', KYBERN_URL: '', KYBERN_TOKEN: '' }
if (path.resolve(scratch.KYBERN_DATA_DIR) === '/Users/mymac/.kybern') throw Error('Refusing the real data dir')
const W = 420, H = 140
const BOXES: Record<string, number> = { wash: 20, solid: 84, scoped: 148, optout: 212, state: 276, press: 340 }
const results: unknown[] = []
const MODES: [string, Record<string, string>][] = [['dark', {}], ['light', { KYBERN_APPEARANCE: 'light' }], ['reduced', { KYBERN_REDUCED_MOTION: '1' }], ['snap', { KYBERN_HOVER_FADE: '0' }]]
for (const [label, env] of MODES) {
  const log = path.join(out, `${label}.log`); rmSync(log, { force: true }); process.env.R7_LOG = log
  const all = () => { try { return readFileSync(log, 'utf8') } catch { return '' } }
  const f = await launchFixture(path.join(import.meta.dir, 'hover-fade-lab.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark', KYBERN_FULL_RATE: '1', KYBERN_FRAME_COSTS: '1', KYBERN_FRAME_TIMES: '1', ...scratch, ...env })
  try {
    const a = f.app; await a.getByTestId('app-ready').waitFor()
    await a.call('focus', { elementId: (await a.getByTestId('app-ready').element()).id })
    const wait = async (check: () => Promise<boolean> | boolean, name: string) => { const deadline = Date.now() + 6000; while (!await check()) { assert.ok(Date.now() < deadline, name); await Bun.sleep(10) } }
    const count = (pattern: RegExp) => (all().match(pattern) ?? []).length
    const settle = async () => { let last = all().length, quiet = performance.now(); await wait(() => { const n = all().length; if (n !== last) { last = n; quiet = performance.now() } return performance.now() - quiet > 250 }, 'settled') }
    const windowId = execFileSync('swift', [path.join(import.meta.dir, '../src/tasks/round7-window-id.swift'), String(f.pid)], { encoding: 'utf8' }).trim()
    // The colour at a point of a box (logical px inside the 48 px box), from an OS capture of the window.
    const capture = async (name: string) => {
      await Bun.sleep(100)
      const file = path.join(out, `${label}-${name}.png`)
      for (let attempt = 0; ; attempt++) {
        execFileSync('screencapture', ['-x', '-o', '-l', windowId, file])
        try { assertNonBlackContent(file, W, H, `${label}-${name}`); break }
        catch (error) { copyFileSync(file, file.replace(/\.png$/, `-rejected-${attempt}.png`)); if (attempt >= 5) throw error; await Bun.sleep(300) }
      }
      const img = pngPixels(file), sc = img.width / W, top = img.height / sc - H
      return (box: string, dx = 24, dy = 24) => img.at(Math.round((BOXES[box]! + dx) * sc), Math.round((top + 40 + dy) * sc)).slice(0, 3)
    }
    // Where `c` lies between `from` and `to` (0 at `from`, 1 at `to`), on the channel that differs most.
    const along = (c: number[], from: number[], to: number[]) => { let k = 0; for (let i = 1; i < 3; i++) if (Math.abs(to[i]! - from[i]!) > Math.abs(to[k]! - from[k]!)) k = i; return (c[k]! - from[k]!) / (to[k]! - from[k]!) }
    const at = (box: string) => a.getByTestId(box).bounds().then(b => ({ x: b!.x + b!.width / 2, y: b!.y + b!.height / 2 }))
    const away = { x: W - 10, y: H - 10 }
    await a.mouse.move(away); await settle()
    const rest = await capture('rest')
    // Frozen clock: step a hover in and out.
    await a.clock.pause()
    let border: number[][] = []
    const steps = async (box: string, name: string, offsets: number[]) => {
      const values: number[][] = []; let t = 0; border = []
      for (const o of offsets) { if (o > t) await a.clock.fastForward(o - t); t = o; const read = await capture(`${name}-${o}`); values.push(read(box)); border.push(read(box, 24, 1)) }
      return values
    }
    await a.mouse.move(await at('wash'))
    const washIn = await steps('wash', 'wash-in', [0, 20, 40, 60, 120])
    const hovered = washIn.at(-1)!, washRest = rest('wash')
    await a.mouse.move(away)
    const washOut = await steps('wash', 'wash-out', [0, 40, 120])
    await a.mouse.move(await at('solid'))
    const solidIn = await steps('solid', 'solid-in', [0, 40, 120]), borderIn = border
    await a.mouse.move(await at('scoped'))
    const scopedIn = await steps('scoped', 'scoped-in', [0, 40, 120])
    await a.mouse.move(await at('optout'))
    const optout = await steps('optout', 'optout-in', [0])
    await a.mouse.move(away); await a.clock.fastForward(200)
    await a.call('keyDown', { key: 's' }); await Bun.sleep(80)
    const state = await steps('state', 'state', [0])
    await a.mouse.move(await at('press')); await a.clock.fastForward(200)
    const pressRest = (await capture('press-rest'))('press')
    await a.call('mouseDown', { ...(await at('press')), button: 0 })
    const pressDown = await steps('press', 'press-down', [0])
    await a.call('mouseUp', { ...(await at('press')), button: 0 })
    const pressUp = await steps('press', 'press-up', [0, 40, 200])
    await a.clock.resume()
    const p = (v: number[][], from: number[], to: number[]) => v.map(c => Math.round(along(c, from, to) * 100) / 100)
    const solidRest = rest('solid'), blue = [0x30, 0x50, 0xe0]
    const report = {
      washIn: p(washIn, washRest, hovered), washOut: p(washOut, hovered, washRest), solidIn: p(solidIn, solidRest, blue),
      borderIn: borderIn.map(c => c.join(',')), scopedIn: p(scopedIn, rest('scoped'), scopedIn.at(-1)!), optout: p(optout, rest('optout'), blue),
      state: p(state, rest('state'), blue), press: { down: p(pressDown, pressRest, blue), up: p(pressUp, blue, pressRest) },
    }
    const fades = label !== 'snap'
    if (fades) {
      const w = report.washIn
      assert.ok(w[0]! > 0 && w[0]! < 0.6, `${label}: the hover's first step is not partial (${w})`)
      for (let i = 1; i < w.length; i++) assert.ok(w[i]! >= w[i - 1]! - 0.02, `${label}: the hover went backwards (${w})`)
      assert.ok(w[1]! < 0.99 && w.at(-1)! > 0.98, `${label}: the hover did not ease to its end (${w})`)
      assert.ok(report.washOut[0]! < 0.7 && report.washOut.at(-1)! > 0.98, `${label}: hover-out did not ease back (${report.washOut})`)
      assert.ok(report.solidIn[1]! > 0.05 && report.solidIn[1]! < 0.99 && report.solidIn.at(-1)! > 0.98, `${label}: fill to fill did not ease (${report.solidIn})`)
      assert.ok(borderIn[0]!.join() !== borderIn.at(-1)!.join(), `${label}: the border colour did not change`)
      assert.ok(report.scopedIn[1]! > 0.05 && report.scopedIn[1]! < 0.99, `${label}: the fill inside a paintTransform did not ease (${report.scopedIn})`)
      assert.ok(report.press.up[1]! > 0.05 && report.press.up[1]! < 0.99 && report.press.up.at(-1)! > 0.98, `${label}: the release did not ease back (${report.press.up})`)
    } else {
      assert.ok(report.washIn[0]! > 0.98, `${label}: the control did not snap (${report.washIn})`)
    }
    assert.ok(report.optout[0]! > 0.98, `${label}: the opt-out eased (${report.optout})`)
    assert.ok(report.state[0]! > 0.98, `${label}: a state change of the rest colour eased (${report.state})`)
    assert.ok(report.press.down[0]! > 0.98, `${label}: the press did not land at once (${report.press.down})`)
    // Live clock: one render for the flip, display-rate presents while it fades, none after.
    await a.mouse.move(away); await settle()
    const frames0 = count(/\[kybern-submit\]/g), renders0 = count(/\[kybern-work\]/g), start = all().length
    await a.mouse.move(await at('wash')); await Bun.sleep(300)
    const tail = all().slice(start).match(/\[kybern-submit\] ([\d.]+)/g)?.map(l => Number(l.split(' ')[1])) ?? []
    const intervals = tail.slice(1).map((t, i) => t - tail[i]!)
    const frames = count(/\[kybern-submit\]/g) - frames0, renders = count(/\[kybern-work\]/g) - renders0
    const idle0 = count(/\[kybern-submit\]/g); await Bun.sleep(600); const idle = count(/\[kybern-submit\]/g) - idle0
    assert.ok(renders <= 2, `${label}: the hover rendered ${renders} times`)
    if (fades) assert.ok(frames >= 5, `${label}: the fade presented ${frames} frames`)
    assert.equal(idle, 0, `${label}: frames after the fade ended`)
    const result = { label, ...report, frames, renders, idle, intervals: intervals.map(v => Math.round(v * 10) / 10) }
    results.push(result)
    console.log(`ok ${label}: wash ${report.washIn} / out ${report.washOut}; fill ${report.solidIn}; scoped ${report.scopedIn}; opt-out ${report.optout}; state ${report.state}; press ${report.press.down} up ${report.press.up}; live ${frames} frames, ${renders} renders, ${idle} after (KYBERN_FULL_RATE=1)`)
  } catch (error) { console.error(all().split('\n').filter(l => !/\[kybern-(frame|submit|work)\]/.test(l)).slice(-30).join('\n')); throw error } finally { await f.close() }
}
writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2))
process.exit(0)
