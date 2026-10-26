// WP8 text parity (PORTING-PLATFORMS.md, "Text"), on text-lab.tsx's type specimen:
//   - every kit weight (450, 550 and 650 included) paints wider than the one below it, in the UI font and in Inter: off
//     macOS that needs the `wght` axis on DirectWrite / cosmic-text and a variable UI font (`platform/fonts.ts`);
//   - line boxes are the line heights the kit asks for, and the cap height and baseline of Inter and JetBrains Mono (the
//     same files on every OS) sit where macOS draws them, within 1 px (1.5 px where glyphs are hinted, below 1.5x)
//     (`text-macos.json`, written by `--record` on a Mac);
//   - code is the code face: its painted width is the character count times the advance the code wrap computes with;
//   - inline code in the rich editor is drawn at its reduced scale (`kszl`);
//   - a `kszl` run is drawn at its scale whichever font its face maps back to: a task chip shaped after an ordered list
//     selected the same face with `tnum` paints as wide as one shaped before it, and an emoji inside inline code is drawn
//     smaller than one outside it;
//   - emoji draw in colour, U+FE0F sequences (❤️ ⚠️ ☀️ 1️⃣) included, and CJK falls back to a font that has it, a full em
//     per character.
// Writes text-<platform>.png and text-metrics-<platform>.json (side-by-side review across OSes).
//   bun native/text-check.ts [--record]
import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { capture, launch, outputDir, platform, pngPixels, step, type Png } from './check-harness.ts'
import { FONTS } from '../src/platform/fonts.ts'
import { BACKGROUND, CJK, EDITOR_SIZE, EMOJI, FOREGROUND, INLINE, INLINE_SCALE, MONO, MONO_PROBE, MONO_PROBE_SIZE, MONO_SIZE, SIZES, WEIGHTS, WRAP_WIDTH } from './text-specimen.ts'

const out = outputDir('text')
const referenceFile = path.join(import.meta.dir, 'text-macos.json')
const record = process.argv.includes('--record')
if (record) assert.equal(platform, 'macos', '--record writes the macOS reference; run it on a Mac')
interface Reference { caps: Record<string, { top: number; baseline: number }>; wrap: number; inline: number }
const reference: Reference | null = !record && existsSync(referenceFile) ? JSON.parse(readFileSync(referenceFile, 'utf8')) : null

type Box = { x: number; y: number; width: number; height: number }
const differs = (p: number[]) => p.some((v, i) => Math.abs(v - BACKGROUND[i]!) > 24)
/** How much of a pixel the text covers, from the specimen's background (0) to its text colour (1). */
const saturated = (p: number[]) => Math.max(...p) - Math.min(...p) > 60
const coverage = (p: number[]) => Math.min(1, Math.max(0, ((p[0]! + p[1]! + p[2]!) / 3 - BACKGROUND[0]) / (FOREGROUND[0] - BACKGROUND[0])))

/**
 * The cap height's top edge and the baseline of a box (logical px from its top). A row's ink is its most covered pixel;
 * the edge rows are partly covered, so each edge sits inside its row by that coverage. Sub-pixel estimates compare a 2x
 * macOS capture with 1x captures, and anti-aliasing that is a little lighter or darker moves them by a fraction, not a row.
 */
function inkRows(png: Png, scale: number, top: number, box: Box) {
  const rows: { y: number; ink: number }[] = []
  for (let y = Math.floor((box.y + top) * scale); y < Math.ceil((box.y + top + box.height) * scale); y++) {
    let ink = 0
    for (let x = Math.ceil(box.x * scale); x < Math.floor((box.x + box.width) * scale); x++) ink = Math.max(ink, coverage(png.at(x, y)))
    if (ink > 0.08) rows.push({ y, ink })
  }
  assert.ok(rows.length, `no ink in ${JSON.stringify(box)}`)
  const first = rows[0]!, last = rows.at(-1)!
  return { top: (first.y + 1 - first.ink) / scale - top - box.y, baseline: (last.y + last.ink) / scale - top - box.y }
}

// Off macOS the text system says how it matched and varied each font (`KYBERN_FONT_DEBUG`, DirectWrite).
const fontDebug: string[] = []
const f = await launch(path.join(import.meta.dir, 'text-lab.tsx'), { KYBERN_APPEARANCE: 'dark', KYBERN_FONT_DEBUG: '1' }, {
  stderr: chunk => { for (const line of chunk.split('\n')) if (line.includes('[font-debug]') && !fontDebug.includes(line.trim()) && fontDebug.length < 80) fontDebug.push(line.trim()) },
})
// Every measurement is taken and saved first, then every assertion runs: one failure must not hide the others.
const failures: string[] = []
const check = async (label: string, run: () => unknown) => {
  try { await step(label, run) } catch (error) { failures.push(`${label}: ${error instanceof Error ? error.message.split('\n')[0] : error}`) }
}
try {
  const a = f.app
  await a.getByTestId('text-ready').waitFor()
  await a.getByTestId('editor').waitFor()
  await a.getByTestId('chip-late').waitFor()
  await Bun.sleep(400)
  const box = async (id: string): Promise<Box> => a.getByTestId(id).bounds()
  const metrics: Record<string, unknown> = { platform, uiFont: FONTS.systemUi ?? '.SystemUIFont (SF Pro)', mono: FONTS.mono }

  const root = await box('text-ready')
  const file = await capture(f, path.join(out, `text-${platform}.png`))
  const png = pngPixels(file), scale = png.width / root.width
  // A capture may include a title bar above the content.
  const top = png.height / scale - root.height

  const ladders: Record<string, number[]> = {}
  for (const ladder of ['ui', 'inter'] as const) {
    ladders[ladder] = []
    for (const w of WEIGHTS) ladders[ladder]!.push((await box(`${ladder}-${w}`)).width)
    metrics[`${ladder}Widths`] = Object.fromEntries(WEIGHTS.map((w, i) => [w, ladders[ladder]![i]]))
  }
  const lineBoxes: Record<string, number> = {}
  for (const [i] of SIZES.entries()) for (const id of [`caps-${i}`, `mcaps-${i}`, `usize-${i}`]) lineBoxes[id] = (await box(id)).height
  metrics.lineBoxes = lineBoxes
  const caps: Reference['caps'] = {}, capBoxes: Record<string, Box> = {}
  for (const [i] of SIZES.entries()) for (const id of [`caps-${i}`, `mcaps-${i}`]) {
    capBoxes[id] = await box(id)
    const rows = inkRows(png, scale, top, capBoxes[id]!)
    caps[id] = { top: +rows.top.toFixed(2), baseline: +rows.baseline.toFixed(2) }
  }
  metrics.caps = caps
  metrics.capBoxes = capBoxes
  const wrap = (await box('wrap')).height
  metrics.wrap = wrap
  const mono = { probe: (await box('mono-probe')).width, mono: (await box('mono')).width, jbm: (await box('jbm')).width }
  metrics.mono = { ...mono, probeExpected: +(MONO_PROBE.length * FONTS.monoAdvance * MONO_PROBE_SIZE).toFixed(2) }

  // The inline code: every column of the editor that differs from the background.
  const editor = await box('editor')
  let left = Infinity, right = -Infinity
  for (let y = Math.ceil((editor.y + top) * scale); y < Math.floor((editor.y + top + editor.height) * scale); y++) {
    for (let x = Math.ceil(editor.x * scale); x < Math.floor((editor.x + editor.width) * scale); x++) {
      if (differs(png.at(x, y))) { left = Math.min(left, x); right = Math.max(right, x) }
    }
  }
  const inline = (right - left + 1) / scale
  const unscaled = INLINE.length * FONTS.monoAdvance * EDITOR_SIZE
  metrics.inline = { painted: +inline.toFixed(2), scaledText: +(unscaled * INLINE_SCALE).toFixed(2), unscaledText: +unscaled.toFixed(2) }

  /** The columns (device px) of a box whose pixels pass `hit`, with how many hit pixels each has. */
  const columns = (b: Box, hit: (p: number[]) => boolean) => {
    const counts = new Map<number, number>()
    for (let y = Math.ceil((b.y + top) * scale); y < Math.floor((b.y + top + b.height) * scale); y++) {
      for (let x = Math.ceil(b.x * scale); x < Math.floor((b.x + b.width) * scale); x++) if (hit(png.at(x, y))) counts.set(x, (counts.get(x) ?? 0) + 1)
    }
    return counts
  }
  const countIn = (counts: Map<number, number>) => [...counts.values()].reduce((sum, n) => sum + n, 0)
  /** Logical width of the ink in a box, from its first to its last column. */
  const inkWidth = (counts: Map<number, number>) => counts.size ? (Math.max(...counts.keys()) - Math.min(...counts.keys()) + 1) / scale : NaN
  /** Logical widths of the runs of hit columns separated by a gap of at least `gap` logical px. */
  const clusters = (counts: Map<number, number>, gap: number) => {
    const xs = [...counts.keys()].sort((p, q) => p - q), out: number[] = []
    let start = xs[0]!, prev = xs[0]!
    for (const x of xs.slice(1)) { if (x - prev > gap * scale) { out.push((prev - start + 1) / scale); start = x } prev = x }
    if (xs.length) out.push((prev - start + 1) / scale)
    return out
  }

  const emoji = await box('emoji')
  const colour = countIn(columns(emoji, saturated))
  metrics.emoji = { width: emoji.width, colourPixels: colour }
  const vs16Colour = countIn(columns(await box('emoji-vs16'), saturated))
  metrics.emojiVs16 = { colourPixels: vs16Colour }
  const chips = { early: inkWidth(columns(await box('chip-early'), differs)), late: inkWidth(columns(await box('chip-late'), differs)) }
  metrics.chips = chips
  const codeEmoji = clusters(columns(await box('code-emoji'), saturated), 3)
  metrics.codeEmoji = codeEmoji
  const cjk = await box('cjk'), em = cjk.width / [...CJK].length / 16
  metrics.cjk = { width: cjk.width, emPerCharacter: +em.toFixed(3) }
  metrics.fontDebug = fontDebug
  writeFileSync(path.join(out, `text-metrics-${platform}.json`), JSON.stringify(metrics, null, 2) + '\n')
  console.log(JSON.stringify(metrics))

  for (const ladder of ['ui', 'inter'] as const) {
    const widths = ladders[ladder]!
    await check(`${ladder} weights paint wider at every step`, () => {
      for (let i = 1; i < WEIGHTS.length; i++) assert.ok(widths[i]! > widths[i - 1]!, `${ladder}: ${WEIGHTS[i]} (${widths[i]}) is not wider than ${WEIGHTS[i - 1]} (${widths[i - 1]}): the weight snapped to a named face`)
    })
  }
  await check('line boxes are the kit line heights', () => {
    for (const [i, [size, lineHeight]] of SIZES.entries()) for (const id of [`caps-${i}`, `mcaps-${i}`, `usize-${i}`]) {
      assert.ok(Math.abs(lineBoxes[id]! - lineHeight) <= 0.5, `${id} (${size}/${lineHeight}): line box ${lineBoxes[id]}`)
    }
    assert.ok(Math.abs(wrap / 20 - Math.round(wrap / 20)) < 0.03, `wrapped paragraph ${wrap} is not whole 20 px lines`)
  })
  // Bounds are whole pixels, rounded up.
  const sameWidth = (painted: number, expected: number) => painted >= expected - 0.05 && painted - expected < 1
  await check('code paints at the code face advance', () => {
    const expected = MONO_PROBE.length * FONTS.monoAdvance * MONO_PROBE_SIZE
    assert.ok(sameWidth(mono.probe, expected), `${FONTS.mono}: ${mono.probe} wide, the code wrap computes ${expected.toFixed(2)} (another face?)`)
    assert.ok(sameWidth(mono.mono, MONO.length * FONTS.monoAdvance * MONO_SIZE), `${FONTS.mono} 13 px: ${mono.mono} wide`)
    assert.ok(sameWidth(mono.jbm, MONO.length * 0.6 * MONO_SIZE), `JetBrains Mono: ${mono.jbm} wide`)
  })
  await check('inline code draws at its reduced scale (kszl)', () => {
    assert.ok(Number.isFinite(inline), 'no inline code painted')
    // The ink (the pill is near the background): nearer the scaled advance than the full one.
    assert.ok(inline < unscaled * (1 + INLINE_SCALE) / 2 && inline > unscaled * INLINE_SCALE * 0.9, `inline code is ${inline.toFixed(1)} wide: its text alone is ${(unscaled * INLINE_SCALE).toFixed(1)} at 0.833 and ${unscaled.toFixed(1)} at full size`)
  })
  await check('emoji draw in colour', () => {
    // Five emoji at 16 px: a monochrome or missing glyph has no saturated pixels.
    assert.ok(colour > 40 * scale * scale, `emoji painted ${colour} coloured pixels`)
    assert.ok(emoji.width > 5 * 16 * 0.9, `emoji row is ${emoji.width} wide`)
  })
  await check('U+FE0F sequences draw in colour', () => {
    // Four emoji at 16 px; a text glyph (❤ in the UI font) has no saturated pixels.
    assert.ok(vs16Colour > 4 * 30 * scale * scale, `❤️⚠️☀️1️⃣ painted ${vs16Colour} coloured pixels`)
  })
  await check('a task chip shaped after a tnum font on its face keeps its scale (kszl)', () => {
    assert.ok(Number.isFinite(chips.early) && Number.isFinite(chips.late), `chips not painted: ${JSON.stringify(chips)}`)
    assert.ok(Math.abs(chips.late - chips.early) <= 1, `the chip shaped after the ordered list is ${chips.late} wide, the one before it ${chips.early}`)
  })
  await check('an emoji inside inline code is drawn at the code scale', () => {
    assert.equal(codeEmoji.length, 2, `expected two emoji, found ink clusters ${JSON.stringify(codeEmoji)}`)
    const ratio = codeEmoji[1]! / codeEmoji[0]!
    assert.ok(ratio < 0.92 && ratio > 0.7, `the inline-code emoji is ${ratio.toFixed(3)} of the other (0.833 expected)`)
  })
  await check('CJK falls back to a font that has it', () => {
    assert.ok(em > 0.85 && em < 1.15, `CJK is ${em.toFixed(2)} em per character (a full em expected; boxes or a proportional fallback otherwise)`)
    inkRows(png, scale, top, cjk)
  })

  if (record) {
    if (failures.length) throw new Error(`not recording a failing run:\n${failures.join('\n')}`)
    writeFileSync(referenceFile, JSON.stringify({ caps, wrap, inline: +inline.toFixed(2) } satisfies Reference, null, 2) + '\n')
    console.log(`recorded ${referenceFile}`)
  } else if (reference) {
    // Below 1.5x DirectWrite and swash hint glyphs, which snaps the cap height and baseline to whole pixels: up to half a
    // pixel per edge on top of the 1 px the unhinted outlines are held to.
    const capTolerance = platform !== 'macos' && scale < 1.5 ? 1.5 : 1
    await check(`cap heights and baselines match macOS within ${capTolerance} px (Inter, JetBrains Mono)`, () => {
      const off = Object.entries(caps).filter(([id, v]) => {
        const r = reference.caps[id]
        return !r || Math.abs(v.top - r.top) > capTolerance || Math.abs(v.baseline - r.baseline) > capTolerance
      }).map(([id, v]) => `${id}: top ${v.top} baseline ${v.baseline} vs macOS ${JSON.stringify(reference.caps[id])}`)
      assert.deepEqual(off, [], off.join('; '))
    })
    await check('the wrapped paragraph has the macOS height', () => assert.ok(Math.abs(wrap - reference.wrap) <= 1, `${wrap} vs macOS ${reference.wrap}`))
    await check('inline code is as wide as on macOS (2 px)', () => assert.ok(Math.abs(inline - reference.inline) <= 2, `${inline.toFixed(2)} vs macOS ${reference.inline}`))
  }
  if (failures.length) throw new Error(`text: ${failures.length} failed\n${failures.join('\n')}`)
  console.log(`ok text (${platform}, UI font ${metrics.uiFont}, code ${FONTS.mono}, ${WRAP_WIDTH} px wrap ${wrap} px)`)
} finally {
  await f.close()
}
