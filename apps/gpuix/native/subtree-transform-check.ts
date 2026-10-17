// `paintTransform` (subtree_transform.rs) in four modes: retained frames equal an ordinary render pixel for pixel,
// hit testing follows the transformed paint, the native press squash works with real mouse down/up, an animated
// transform presents frames without renders, layout or island wakes, and the layout slot never moves.
import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { launchFixture } from '../src/tasks/round7b-harness.ts'
import { pngPixels } from './clip-pixels.ts'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? path.join(import.meta.dir, 'build/subtree-transform'); mkdirSync(out, { recursive: true })
const scratch = { KYBERN_DATA_DIR: process.env.KYBERN_DATA_DIR ?? '/Users/mymac/projects/ade-gpuix-scratch/phase2-render9', KYBERN_CLIENT_CONFIG_DIR: process.env.KYBERN_CLIENT_CONFIG_DIR ?? '/Users/mymac/projects/ade-gpuix-scratch/phase2-render9-client', KYBERN_URL: '', KYBERN_TOKEN: '' }
const quantile = (values: number[], q: number) => { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? NaN }
for (const theme of ['dark', 'light']) for (const reduce of ['0', '1']) {
  const label = `${theme}-${reduce === '1' ? 'reduced' : 'normal'}${process.env.KYBERN_REGION_PAINT === '1' ? '-region' : ''}`
  const log = path.join(out, `${label}.log`); rmSync(log, { force: true }); process.env.R7_LOG = log
  const all = () => { try { return readFileSync(log, 'utf8') } catch { return '' } }
  const f = await launchFixture(path.join(import.meta.dir, 'subtree-transform-lab.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: reduce, KYBERN_FULL_RATE: '1', KYBERN_DEBUG_ISLANDS: '1', KYBERN_FRAME_COSTS: '1', KYBERN_FRAME_TIMES: '1', ...scratch })
  try {
    const a = f.app; await a.getByTestId('app-ready').waitFor()
    const root = (await a.getByTestId('app-ready').element()).id
    const bounds = async (testId: string) => a.getByTestId(testId).bounds()
    await a.call('focus', { elementId: root })
    const key = async (key: string) => { await a.call('keyDown', { key }) }
    const wait = async (check: () => Promise<boolean> | boolean, name: string) => { const deadline = Date.now() + 6000; while (!await check()) { assert.ok(Date.now() < deadline, name); await Bun.sleep(10) } }
    const count = (pattern: RegExp) => (all().match(pattern) ?? []).length
    const windowId = execFileSync('swift', [path.join(import.meta.dir, '../src/tasks/round7-window-id.swift'), String(f.pid)], { encoding: 'utf8' }).trim()
    const shot = (name: string) => { const file = path.join(out, `${label}-${name}.png`); execFileSync('screencapture', ['-x', '-o', '-l', windowId, file]); return file }
    const settle = async () => { let last = all().length, quiet = performance.now(); await wait(() => { const n = all().length; if (n !== last) { last = n; quiet = performance.now() } return performance.now() - quiet > 250 }, 'settled') }
    await key('q'); await settle()
    const slot = await bounds('slot'), card = await bounds('scope')
    let tick = 0
    // GPUIX renders for key input itself (modality); measure that with a key that changes nothing.
    const k0 = count(/\[kybern-work\]/g); await key('q'); await settle(); const keyBaseline = count(/\[kybern-work\]/g) - k0
    // Retained (paint-only) results equal an ordinary render of the same value.
    for (const state of ['s', 'r', 'c', 'b']) {
      const renders = count(/\[kybern-work\]/g), islands = f.islandRenders()
      await key(state); await settle()
      // The first change from the identity renders once (an identity scope keeps no retained paint), and so does the
      // first blur (it adds the blur pass).
      assert.ok(count(/\[kybern-work\]/g) - renders <= keyBaseline + (state === 's' || state === 'b' ? 1 : 0), `${state}: a transform value change rendered the window`)
      assert.equal(f.islandRenders(), islands, `${state}: a transform woke an island`)
      const retained = shot(`${state}-retained`); await key('t'); tick++; await a.getByText(`Tick ${tick}; clicks 0; presses 0`).waitFor(); await settle()
      const full = shot(`${state}-full`)
      const left = pngPixels(retained), right = pngPixels(full), scale = left.width / 520; let changed = 0
      for (let y = Math.round(87 * scale); y < 300 * scale; y++) for (let x = Math.round(10 * scale); x < 280 * scale; x++) { const p = left.at(x, y), q = right.at(x, y); if (p.some((v, i) => Math.abs(v - q[i]!) > 3)) changed++ }
      assert.ok(changed < 40, `${state}: retained paint differs from an ordinary render (${changed} px)`)
      assert.deepEqual(await bounds('slot'), slot, `${state}: layout slot moved`)
    }
    // Hit testing follows the paint: at scale .5 about the card's centre the inner button sits at (167.5, 162.5).
    await key('s'); await settle()
    const cx = card.x + card.width / 2, cy = card.y + card.height / 2
    await a.mouse.click({ x: cx + (155 - 100) * 0.5, y: cy + (125 - 80) * 0.5 }); await a.getByText(`Tick ${tick}; clicks 1; presses 0`).waitFor()
    await a.mouse.click({ x: card.x + 155, y: card.y + 125 }); await Bun.sleep(150)
    assert.ok(await a.getByText(`Tick ${tick}; clicks 1; presses 0`).count(), 'a press where the button was before scaling still hit it')
    await key('z'); await settle()
    // The native press squash: scale .5 while the primary button is down, back on release, and the click lands.
    const press = await bounds('press'), corner = { x: press.x + 6, y: press.y + 30 }
    // GPUIX renders once for any mouse down (input modality); the press itself must add nothing to that.
    const island = await bounds('unrelated'), base0 = count(/\[kybern-work\]/g)
    await a.mouse.down({ x: island.x + 20, y: island.y + 20 }); await settle(); await a.mouse.up({ x: island.x + 20, y: island.y + 20 }); await settle()
    const baseline = count(/\[kybern-work\]/g) - base0, before = count(/\[kybern-work\]/g)
    await a.mouse.down({ x: press.x + press.width / 2, y: press.y + press.height / 2 }); await settle()
    const down = pngPixels(shot('press-down')), sc = down.width / 520, top = down.height / sc - 300, bg = theme === 'light' ? 0xf5 : 0x20
    assert.ok(Math.abs(down.at(corner.x * sc, (corner.y + top) * sc)[0]! - bg) < 6, 'pressed button did not shrink')
    const pressRenders = count(/\[kybern-work\]/g) - before
    await a.mouse.up({ x: press.x + press.width / 2, y: press.y + press.height / 2 }); await a.getByText(`Tick ${tick}; clicks 1; presses 1`).waitFor(); await settle()
    // The release also renders for the click (the probe measured 2 for any onClick element, transformed or not).
    assert.ok(count(/\[kybern-work\]/g) - before <= baseline + 2, `press rendered beyond the input baseline (${pressRenders} on down)`)
    const up = pngPixels(shot('press-up'))
    assert.ok(Math.abs(up.at(corner.x * sc, (corner.y + top) * sc)[0]! - 0x90) < 8, 'released button did not return')
    // An animated transform: display-rate frames, no renders.
    await key('a'); await settle()
    const frames0 = count(/\[kybern-frame\]/g), renders0 = count(/\[kybern-work\]/g), startText = all().length
    await key('s'); await Bun.sleep(700); await settle()
    const tail = all().slice(startText).match(/\[kybern-frame\] ([\d.]+)/g)?.map(l => Number(l.split(' ')[1])) ?? []
    const intervals = tail.slice(1).map((t, i) => t - tail[i]!).filter(d => d < 100)
    const frames = count(/\[kybern-frame\]/g) - frames0, renders = count(/\[kybern-work\]/g) - renders0 - keyBaseline
    if (reduce === '0') assert.ok(frames >= 15, `animated transform presented ${frames} frames`)
    assert.ok(renders <= 1, `animated transform rendered ${renders} times`)
    const result = { label, frames, renders, p50: quantile(intervals, 0.5), p95: quantile(intervals, 0.95), slot, card }
    writeFileSync(path.join(out, `${label}.json`), JSON.stringify(result, null, 2))
    console.log(`ok ${label}: retained = full render (s, r, c, b), hit testing, native press, fixed slot; 400 ms transform: ${frames} frames, ${renders} renders, p50 ${result.p50?.toFixed(1)} ms, p95 ${result.p95?.toFixed(1)} ms`)
  } catch (error) { console.error(all().split('\n').filter(l => !/\[kybern-(frame|submit|work)\]/.test(l)).slice(-40).join('\n')); throw error } finally { await f.close() }
}
