// One link, one straight underline: a link containing inline code, a bold link, bold and code in one link, a link wrapped
// onto two lines (inline flow and single run) and links that lead with an icon each draw exactly one 1 px line per visual
// line, at one height, from the link's first glyph to its last with no gap, never under the icon and never under the
// space a line wraps at, and the icon painted in its slot right before the link's text, whether that text is plain or
// inline code and whatever comes before the link. Hover and always modes, dark and light. Runs on macOS, Linux and Windows.
//   bun native/link-underline-check.ts [--baseline]     (--baseline records without asserting, for a before/after)
import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import {writeFileSync} from 'node:fs'
import path from 'node:path'
import {launch, capture, outputDir, pngPixels, step, settled, type Png, type Rect} from './check-harness.ts'
import {CASES, LINK_INK, ICON_INK} from './link-underline-lab.tsx'

const out = outputDir('link-underline')
const baseline = process.argv.includes('--baseline'), tag = baseline ? 'before' : 'after'
const WIDTH = 600
const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
const near = (c: number[], ref: number[], slack: number) => c.every((v, i) => Math.abs(v - ref[i]!) <= slack)
const link = rgb(LINK_INK), icon = rgb(ICON_INK)
/** A strongly link-coloured glyph pixel; sub-pixel fringes of white or black text can be pinkish, never this saturated. */
const glyph = (c: number[]) => near(c, link, 70) && c[1]! < c[0]! - 100 && c[1]! < c[2]! - 100

type Line = {y: number; rows: number; left: number; right: number; inkLeft: number; inkRight: number; iconLeft: number | null; iconRight: number | null}
/**
 * The underlines inside `box` (logical px): rows whose longest unbroken run of exact link-colour pixels is at least
 * `min` px, grouped into lines by adjacency, each with that run and the extent of the link's glyphs (and icon) in the
 * line box above it. Glyph pixels are anti-aliased and found with more slack; a crisp underline is the exact colour.
 */
function underlines(png: Png, scale: number, box: Rect, lineHeight: number, min = 24): Line[] {
  const x0 = Math.floor(box.x * scale), x1 = Math.ceil((box.x + box.width) * scale), y0 = Math.floor(box.y * scale), y1 = Math.ceil((box.y + box.height) * scale)
  const run = (y: number) => {
    let best = {left: 0, right: -1}, start = -1
    for (let x = x0; x <= x1; x++) {
      const hit = x < x1 && near(png.at(x, y), link, 24)
      if (hit && start < 0) start = x
      if (!hit && start >= 0) { if (x - 1 - start > best.right - best.left) best = {left: start, right: x - 1}; start = -1 }
    }
    return best
  }
  const lines: Line[] = []
  for (let y = y0; y < y1; y++) {
    const r = run(y)
    if (r.right - r.left + 1 < min * scale) continue
    const last = lines.at(-1)
    if (last && y === last.y + last.rows) { last.rows++; continue }
    lines.push({y, rows: 1, left: r.left, right: r.right, inkLeft: Infinity, inkRight: -Infinity, iconLeft: null, iconRight: null})
  }
  for (const line of lines) {
    // The glyphs sit within 20 px above their underline (2 px above the bottom of a ~23 px line box); a paragraph's box can
    // be taller than its lines, so the band never reaches the paragraph above.
    for (let y = Math.max(y0, line.y - Math.round(Math.min(lineHeight, 20) * scale)); y < line.y; y++) for (let x = x0; x < x1; x++) {
      const c = png.at(x, y)
      if (glyph(c)) { line.inkLeft = Math.min(line.inkLeft, x); line.inkRight = Math.max(line.inkRight, x) }
      if (near(c, icon, 40)) { line.iconLeft = Math.min(line.iconLeft ?? Infinity, x); line.iconRight = Math.max(line.iconRight ?? -Infinity, x) }
    }
  }
  return lines
}

const results: Record<string, unknown>[] = []
for (const appearance of ['dark', 'light'] as const) for (const mode of ['always', 'hover'] as const) {
  const f = await launch(path.join(import.meta.dir, 'link-underline-lab.tsx'), {KYBERN_APPEARANCE: appearance, KYBERN_LINK_UNDERLINE: mode, KYBERN_URL: ''})
  try {
    const a = f.app
    await a.getByTestId('ready').waitFor()
    const away = {x: WIDTH - 8, y: 8}
    await a.mouse.move(away)
    const shot = async (label: string) => {
      const file = await capture(f, path.join(out, `${tag}-${appearance}-${mode}-${label}.png`))
      const png = pngPixels(file)
      return {png, scale: png.width / WIDTH}
    }
    const rest = await settled(() => shot('rest'), s => s.png.width > 0)
    for (const [id, spec] of Object.entries(CASES)) {
      const box = await a.getByTestId(id).bounds()
      const lineHeight = box.height / spec.lines
      let found = underlines(rest.png, rest.scale, box, lineHeight), scale = rest.scale
      const label = `${appearance} ${mode} ${id}`
      if (mode === 'hover') {
        await step(`${label}: no underline at rest`, () => assert.equal(found.length, baseline ? found.length : 0, `${found.length} underline(s) before hovering`))
        // Hover the middle of the link's first line: its glyphs are the only link-coloured pixels there.
        const probe = glyphsOnFirstLine(rest.png, rest.scale, box, lineHeight)
        assert.ok(probe, `${label}: the link's glyphs are painted`)
        await a.mouse.move(probe)
        const hovered = await settled(() => shot(id), s => underlines(s.png, s.scale, box, lineHeight).length >= spec.lines, 2000)
        found = underlines(hovered.png, hovered.scale, box, lineHeight); scale = hovered.scale
        await a.mouse.move(away)
        await settled(() => shot('rest-again'), s => underlines(s.png, s.scale, box, lineHeight).length === 0, 2000)
      }
      const slack = 3 * scale
      results.push({appearance, mode, id, lines: found.map(l => ({y: l.y / scale, rows: l.rows, left: l.left / scale, right: l.right / scale, inkLeft: l.inkLeft / scale, inkRight: l.inkRight / scale, iconLeft: l.iconLeft === null ? null : l.iconLeft / scale, iconRight: l.iconRight === null ? null : l.iconRight / scale}))})
      if (baseline) continue
      await step(`${label}: one straight underline per line`, () => {
        assert.equal(found.length, spec.lines, `${found.length} underline row group(s) for ${spec.lines} line(s): ${JSON.stringify(found)}`)
        for (const line of found) assert.ok(line.rows <= Math.ceil(scale), `one 1 px row, not ${line.rows} device rows: a stepped line spans several`)
      })
      await step(`${label}: from the first glyph to the last, no gaps`, () => {
        for (const [index, line] of found.entries()) {
          assert.ok(Math.abs(line.left - line.inkLeft) <= slack, `line ${index + 1} starts at ${line.left}, its first glyph at ${line.inkLeft}`)
          assert.ok(Math.abs(line.right - line.inkRight) <= slack, `line ${index + 1} ends at ${line.right}, its last glyph at ${line.inkRight} (no run under the space it wraps at); box ${JSON.stringify(box)}`)
        }
      })
      if (spec.icon) await step(`${label}: never under the icon`, () => {
        const line = found[0]!
        assert.ok(line.iconLeft !== null && line.iconRight !== null, 'the icon is painted')
        // In its slot: about icon-sized, and just before the link's first glyph (a code chip's padding in between).
        const width = (line.iconRight! - line.iconLeft! + 1) / scale, gap = (line.inkLeft - line.iconRight!) / scale
        assert.ok(width >= 10 && width <= 18, `the icon is ${width} px wide, not one icon in its slot`)
        assert.ok(gap > 0 && gap <= 14, `the icon ends ${gap} px before the link's first glyph, not in the slot right before it`)
        assert.ok(line.left > line.iconRight!, `the underline starts at ${line.left}, inside the icon (ends at ${line.iconRight})`)
      })
    }
  } catch (error) { console.error(f.diagnostics()); throw error } finally { await f.close() }
}
writeFileSync(path.join(out, `${tag}.json`), JSON.stringify(results, null, 1))
console.log(`link-underline: ${results.length} cases ${baseline ? 'recorded' : 'passed'}; captures and ${tag}.json in ${out}`)

/** The middle of the link's glyphs on its first visual line, in window coordinates. */
function glyphsOnFirstLine(png: Png, scale: number, box: Rect, lineHeight: number): {x: number; y: number} | null {
  const y0 = Math.floor(box.y * scale), y1 = Math.floor((box.y + lineHeight) * scale)
  let left = Infinity, right = -Infinity
  for (let y = y0; y < y1; y++) for (let x = Math.floor(box.x * scale); x < Math.ceil((box.x + box.width) * scale); x++) {
    const c = png.at(x, y)
    if (glyph(c)) { left = Math.min(left, x); right = Math.max(right, x) }
  }
  return left <= right ? {x: (left + right) / 2 / scale, y: box.y + lineHeight / 2} : null
}
