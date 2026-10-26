// The scene backdrop filter on this OS's renderer (WP9): `backdrop-blur-lab.tsx` captured with the filter on and, off
// macOS, with `KYBERN_BACKDROP_FILTER=0` (the fallback), then a perf pass over a busy scene.
//
// Pixels, on the filter-on capture:
//   card   the stripes behind it lose their contrast (row deviation under a fifth of the raw stripes'), its tint is on
//          the blurred mean, its rounded-off corner still shows the raw stripe, and the red bar painted inside it stays sharp
//   chain  a filter inside a rounded overflow parent is cut by the parent's curve (the clip chain), blurred inside
//   menu   blur 40 at saturation 1.5 over red/blue stripes: flat, and more saturated than the plain mean
// and on the filter-off capture the card's stripes are still there (so the check can tell the two apart).
//   odd    (BACKDROP_LAB_ODD=1) a half-opacity frost over a whole 721 x 481 window: its last device column and row keep the
//          flat background, which they lose when an odd crop is left partly uncopied (WP9 review S1)
// The addon's reports for the window (BACKDROP_LAB_INFO): `backdropFilterSupported()` is true with the filter and false with
// `KYBERN_BACKDROP_FILTER=0` off macOS, `setWindowAppearance` applies on Windows only, and `readOsDisplay()` reads this OS's
// transparency and contrast options (Windows: it must return values).
//
// Perf (relative only: lavapipe and WARP render on the CPU): frames drawn per second and process CPU per frame over a busy
// scene kept drawing by a paint animation, with no surfaces, the surfaces filtered, the surfaces at full resolution
// (`KYBERN_BACKDROP_HALFRES=0`) and, off macOS, the surfaces unfiltered. Written to `perf.json` and logged.
import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { capture, launch, outputDir, platform, pngPixels, step, type Png, type Rect } from './check-harness.ts'

const out = outputDir('backdrop')
const lab = path.join(import.meta.dir, 'backdrop-blur-lab.tsx')
const WIDTH = 720
const luminance = ([r, g, b]: number[]) => 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
// Software renderers, the half-resolution path and Metal's own rounding differ by a few levels; colour targets get room.
const slack = 16

/** Device pixels of one logical row, `x0`…`x1`, at logical `y`. */
function row(png: Png, scale: number, x0: number, x1: number, y: number): number[][] {
  const values: number[][] = []
  for (let x = Math.ceil(x0 * scale); x < Math.floor(x1 * scale); x++) values.push(png.at(x, Math.floor(y * scale)))
  return values
}
const mean = (values: number[][]) => [0, 1, 2].map(c => values.reduce((sum, v) => sum + v[c]!, 0) / values.length)
const deviation = (values: number[]) => {
  const m = values.reduce((a, b) => a + b, 0) / values.length
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length)
}
const near = (actual: number[], expected: number[], tol = slack) => actual.every((v, i) => Math.abs(v - expected[i]!) <= tol)
const fmt = (v: number[]) => `(${v.map(c => Math.round(c)).join(', ')})`

type Info = { backdropFilterSupported: { value?: boolean; error?: string } | null; setWindowAppearance: { value?: boolean; error?: string } | null; osDisplay: { value?: unknown; error?: string } }
async function shot(name: string, env: Record<string, string>, ids = ['card', 'sharp', 'chain', 'menu']) {
  const infoFile = path.join(out, `${name}-info.json`)
  const f = await launch(lab, { KYBERN_APPEARANCE: 'dark', BACKDROP_LAB_INFO: infoFile, ...env })
  try {
    await f.app.getByTestId('ready').waitFor()
    await f.app.getByTestId('info-done').waitFor()
    const bounds: Record<string, Rect> = {}
    for (const id of ids) bounds[id] = await f.app.getByTestId(id).bounds()
    // Two frames after the first: the filter needs the scene drawn once (no animation runs in this scene).
    await Bun.sleep(400)
    const file = path.join(out, `${name}.png`)
    await capture(f, file)
    writeFileSync(path.join(out, `${name}-bounds.json`), JSON.stringify(bounds, null, 2))
    const info = JSON.parse(readFileSync(infoFile, 'utf8')) as Info
    console.log(`${name}: ${JSON.stringify(info)}`)
    return { png: pngPixels(file), bounds, info }
  } catch (error) {
    console.error(f.diagnostics())
    throw error
  } finally {
    await f.close()
  }
}

const on = await shot(`backdrop-${platform}`, {})
const scale = on.png.width / WIDTH
const { card, sharp, chain, menu } = on.bounds as Record<'card' | 'sharp' | 'chain' | 'menu', Rect>
console.log(`capture ${on.png.width}x${on.png.height} (scale ${scale})`)

// The raw white/black stripes between the card and the chain, as the contrast reference.
const raw = row(on.png, scale, 4, 52, card.y + card.height + 25)
const rawDeviation = deviation(raw.map(luminance))
assert.ok(rawDeviation > 100, `the raw stripes should be high contrast (deviation ${rawDeviation.toFixed(1)}): is the lab drawn?`)

await step('card: blurred behind', () => {
  const inside = row(on.png, scale, card.x + 24, card.x + 110, card.y + 30)
  const d = deviation(inside.map(luminance))
  console.log(`card row deviation ${d.toFixed(1)} vs raw stripes ${rawDeviation.toFixed(1)}`)
  assert.ok(d < rawDeviation / 5, `card: the stripes behind it are not blurred (deviation ${d.toFixed(1)}, raw ${rawDeviation.toFixed(1)})`)
})
await step('card: tinted', () => {
  // rgba(40, 120, 220, 0.25) over the blurred mean of white and black (127.5).
  const expected = [0, 1, 2].map(c => [40, 120, 220][c]! * 0.25 + 127.5 * 0.75)
  const actual = mean(row(on.png, scale, card.x + 24, card.x + 110, card.y + 120))
  console.log(`card tint ${fmt(actual)}, expected ${fmt(expected)}`)
  assert.ok(near(actual, expected), `card: tint ${fmt(actual)} is not the blurred mean under the tint ${fmt(expected)}`)
})
await step('card: clipped to its radius', () => {
  for (const [x, y] of [[card.x + 1.5, card.y + 1.5], [card.x + card.width - 1.5, card.y + 1.5], [card.x + 1.5, card.y + card.height - 1.5], [card.x + card.width - 1.5, card.y + card.height - 1.5]]) {
    const l = luminance(on.png.at(x! * scale, y! * scale))
    assert.ok(l < 40 || l > 215, `card: corner ${Math.round(x!)},${Math.round(y!)} is ${Math.round(l)}, not a raw stripe: the filter leaked past its radius`)
  }
  const edge = luminance(on.png.at((card.x + 3) * scale, (card.y + card.height / 2) * scale))
  assert.ok(edge > 60 && edge < 190, `card: just inside its straight edge the backdrop should be filtered (luminance ${Math.round(edge)})`)
})
await step('card: its own content stays sharp', () => {
  const centre = on.png.at((sharp.x + sharp.width / 2) * scale, (sharp.y + sharp.height / 2) * scale)
  assert.ok(near(centre, [255, 0, 0], 10), `card: the red bar is ${fmt(centre)}, not sharp red`)
  const beside = on.png.at((sharp.x - 4) * scale, (sharp.y + sharp.height / 2) * scale)
  assert.ok(beside[0]! < 170, `card: 4 px beside the bar is ${fmt(beside)}: the bar bled`)
})
await step('chain: cut by the rounded parent, blurred inside', () => {
  const corner = luminance(on.png.at((chain.x + 4) * scale, (chain.y + 4) * scale))
  assert.ok(corner < 40 || corner > 215, `chain: the parent's rounded corner shows ${Math.round(corner)}, not the raw stripe`)
  const inside = row(on.png, scale, chain.x + 40, chain.x + 200, chain.y + chain.height / 2)
  const d = deviation(inside.map(luminance))
  assert.ok(d < rawDeviation / 5, `chain: not blurred inside the parent (deviation ${d.toFixed(1)})`)
  assert.ok(near(mean(inside), [127.5, 127.5, 127.5]), `chain: interior ${fmt(mean(inside))} is not the stripes' mean`)
})
await step('menu: blurred and saturated', () => {
  const inside = row(on.png, scale, menu.x + 30, menu.x + menu.width - 30, menu.y + menu.height - 40)
  const m = mean(inside)
  const d = deviation(inside.map(v => v[0]!))
  // Red/blue mean (127.5, 0, 127.5) at saturation 1.5 is (173, 0, 173); under 10% white, (181, 26, 181). At saturation 1
  // it would be (140, 26, 140).
  console.log(`menu ${fmt(m)} (deviation ${d.toFixed(1)}), expected (181, 26, 181)`)
  assert.ok(d < 12, `menu: the stripes behind it are not blurred (red deviation ${d.toFixed(1)})`)
  assert.ok(near(m, [181, 26, 181], slack + 4), `menu: ${fmt(m)} is not the saturated blur (181, 26, 181)`)
  const corner = on.png.at((menu.x + 1) * scale, (menu.y + 1) * scale)
  assert.ok(near(corner, [255, 0, 0], 40) || near(corner, [0, 0, 255], 40), `menu: corner ${fmt(corner)} is not a raw stripe`)
})

await step('addon reports: backdrop support, window appearance, OS display options', () => {
  assert.equal(on.info.backdropFilterSupported?.value, true, `backdropFilterSupported() should be true with the filter on: ${JSON.stringify(on.info.backdropFilterSupported)}`)
  assert.equal(on.info.setWindowAppearance?.value, platform === 'windows', `setWindowAppearance('dark') should apply on Windows only: ${JSON.stringify(on.info.setWindowAppearance)}`)
  assert.ok(!on.info.osDisplay.error, `readOsDisplay() threw: ${on.info.osDisplay.error}`)
  if (platform === 'windows') {
    const display = on.info.osDisplay.value as { reduceTransparency?: unknown; increaseContrast?: unknown } | null
    assert.ok(display && typeof display.reduceTransparency === 'boolean' && typeof display.increaseContrast === 'boolean', `readOsDisplay() read nothing on Windows: ${JSON.stringify(display)}`)
  }
})

const odd = await shot(`backdrop-${platform}-odd`, { BACKDROP_LAB_ODD: '1' }, ['odd'])
await step('odd window: the last column and row keep the background under a half-opacity frost', () => {
  const frost = odd.bounds.odd!
  // The device scale of the first capture: the window can come out a pixel larger than asked, never the frost.
  const oddScale = scale
  const right = Math.floor((frost.x + frost.width) * oddScale) - 1, bottom = Math.floor((frost.y + frost.height) * oddScale) - 1
  console.log(`odd capture ${odd.png.width}x${odd.png.height}, frost ${frost.width}x${frost.height} (last column ${right}, last row ${bottom})`)
  const green = [0, 160, 0]
  // Away from the stripes (x 40…360, y 40…240) by more than the blur's 3-sigma halo.
  for (let y = 0; y <= bottom; y += 7) assert.ok(near(odd.png.at(right, y), green, 6), `odd: last column at y=${y} is ${fmt(odd.png.at(right, y))}, not the background ${fmt(green)}`)
  assert.ok(near(odd.png.at(right, bottom), green, 6), `odd: the last pixel is ${fmt(odd.png.at(right, bottom))}`)
  for (let x = Math.ceil(420 * oddScale); x <= right; x += 7) assert.ok(near(odd.png.at(x, bottom), green, 6), `odd: last row at x=${x} is ${fmt(odd.png.at(x, bottom))}, not the background ${fmt(green)}`)
  // At half coverage the white/green stripes keep half their contrast: half the raw deviation, not all of it.
  const rawOdd = (255 - luminance(green)) / 2
  const inside = row(odd.png, oddScale, 60, 200, 140)
  const d = deviation(inside.map(luminance))
  console.log(`odd: stripe deviation ${d.toFixed(1)} under the frost, raw ${rawOdd.toFixed(1)}`)
  assert.ok(Math.abs(d - rawOdd / 2) < rawOdd * 0.15, `odd: the stripes under the half-opacity frost should keep half their contrast (deviation ${d.toFixed(1)}, raw ${rawOdd.toFixed(1)})`)
})

if (platform !== 'macos') {
  const off = await shot(`backdrop-${platform}-off`, { KYBERN_BACKDROP_FILTER: '0' })
  await step('filter off: backdropFilterSupported() reports false, so the app falls back to dense fills', () => {
    assert.equal(off.info.backdropFilterSupported?.value, false, `backdropFilterSupported() with KYBERN_BACKDROP_FILTER=0: ${JSON.stringify(off.info.backdropFilterSupported)}`)
  })
  await step('filter off: the stripes show through the card (the fallback the check must tell apart)', () => {
    const inside = row(off.png, scale, card.x + 24, card.x + 110, card.y + 30)
    const d = deviation(inside.map(luminance))
    console.log(`filter off: card row deviation ${d.toFixed(1)}`)
    assert.ok(d > rawDeviation / 2, `filter off: the card should show sharp stripes (deviation ${d.toFixed(1)})`)
  })
}

// ---- perf ----
const configs: [string, Record<string, string>][] = [
  ['no surfaces', { BACKDROP_LAB_SURFACES: '0' }],
  ['filtered', {}],
  ['filtered, full resolution', { KYBERN_BACKDROP_HALFRES: '0' }],
  ...(platform !== 'macos' ? [['unfiltered (fallback)', { KYBERN_BACKDROP_FILTER: '0' }] as [string, Record<string, string>]] : []),
]
const perf: Record<string, unknown> = { platform, scene: 'backdrop-blur-lab busy (34 text rows over stripes, breathing dot); card + chain + menu' }
await step('perf: frames and CPU per frame', async () => {
  for (const [label, env] of configs) {
    const file = path.join(out, `perf-${label.replace(/[^a-z]+/g, '-')}.json`)
    // The scene loop must stay in GPUI's renderer on macOS too (Core Animation would take the breathing dot over).
    const f = await launch(lab, { KYBERN_APPEARANCE: 'dark', BACKDROP_LAB_BUSY: '1', BACKDROP_LAB_STATS: file, KYBERN_COMPOSITOR_LOOPS: '0', ...env })
    try {
      await f.app.getByTestId('stats-done').waitFor({ timeoutMs: 60_000 })
      if (label === 'filtered') await capture(f, path.join(out, `perf-busy-${platform}.png`))
    } finally {
      await f.close()
    }
    assert.ok(existsSync(file), `perf ${label}: the lab wrote no stats`)
    perf[label] = JSON.parse(readFileSync(file, 'utf8'))
    const s = perf[label] as { framesPerSecond: number | null; cpuMsPerFrame: number | null; processCpuPercent: number }
    console.log(`perf ${label}: ${s.framesPerSecond?.toFixed(1) ?? '?'} frames/s, ${s.cpuMsPerFrame?.toFixed(2) ?? '?'} ms CPU/frame, ${s.processCpuPercent.toFixed(0)}% CPU`)
  }
  writeFileSync(path.join(out, 'perf.json'), JSON.stringify(perf, null, 2))
})
console.log(`ok backdrop (${platform}): blurred, tinted, clipped (own radius and the rounded chain), saturated, content sharp, odd edges kept`)
