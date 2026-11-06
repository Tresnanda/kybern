// `<diff softWrap>` (the PR Changes view's "Wrap lines"): wrapped rows grow and keep their gutters, numbers sit on the
// first visual line, nothing scrolls sideways, a width change re-measures, line clicks and Show more target the right
// rows, and exact list anchors (inside a wrapped row) survive wrap toggles, remounts and restores. Dark and light.
import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import path from 'node:path'
import { launch, capture, outputDir, pngPixels, sample, settled, tolerance, type Png } from './check-harness.ts'

const out = outputDir('diff-wrap')
const LH = 13 * 1.65
type Rect = { x: number; y: number; width: number; height: number }
type Hl = { sub: number; text: string; rects: Rect[] }

for (const appearance of ['dark', 'light'] as const) {
  const f = await launch(path.join(import.meta.dir, 'diff-wrap-lab.tsx'), { KYBERN_APPEARANCE: appearance, KYBERN_URL: '' })
  try {
    const a = f.app
    await a.getByTestId('ready').waitFor()
    const root = (await a.getByTestId('ready').element()).id
    const key = async (k: string) => { await a.call('keyDown', { elementId: root, key: k }); await a.clock.fastForward(48); await Bun.sleep(80) }
    const inspect = async () => { await key('i'); return JSON.parse(await a.getByTestId('result').textContent()) }
    const rects = (s: any, text: string, sub: number): Rect[] | undefined => (s.highlights as Hl[]).find(h => h.text === text && h.sub === sub)?.rects
    const row = (s: any, line: number) => {
      const sub = line + 1, start = rects(s, 'WRAPSTART', sub)?.[0], end = rects(s, 'WRAPEND', sub)?.at(-1), lead = rects(s, 'export', sub)?.[0]
      const next = rects(s, 'short', sub + 1)?.[0]
      assert.ok(start && end && lead && next, `line ${line}: highlights for its row and the next are painted`)
      return { start: start!, end: end!, lead: lead!, next: next!, lines: Math.round((next!.y - lead!.y) / LH) }
    }
    let s = await settled(inspect, s => !!rects(s, 'WRAPEND', 4) && !!rects(s, 'short', 8))
    const bounds = await a.getByTestId('diff').bounds()

    // Wrapped rows grow; the rows around them do not overlap or move sideways.
    const add = row(s, 3)
    assert.ok(add.lines >= 2, `long addition wraps: ${add.lines} visual lines`)
    assert.ok(add.end.y >= add.lead.y + LH - 1 && add.end.y < add.next.y, 'its end sits on a later visual line, above the next row')
    assert.ok(add.end.x + add.end.width <= bounds.x + bounds.width + 0.5, 'wrapped text stays inside the diff')
    const shortRow = rects(s, 'short', 3)![0]!
    assert.ok(Math.abs(add.lead.y - shortRow.y - LH) < 1, 'a short row stays one line height')
    const del = row(s, 6)
    assert.equal(del.lines, add.lines, 'deletions wrap like additions')

    const shot = async (name: string) => pngPixels(await capture(f, path.join(out, `${appearance}-${name}.png`)))
    const png = await shot('wrapped')
    const scale = png.width / 740
    // Numbers sit on the first visual line only; the gutter and row tints fill every visual line.
    const gutter = (y: number): Rect => ({ x: bounds.x + 2, y: y + 3, width: add.lead.x - 26 - bounds.x - 2, height: LH - 6 })
    const ink = (p: Png, r: Rect, ref: number[]) => sample(p, scale, r, 1).filter(c => c.some((v, i) => Math.abs(v - ref[i]!) > 60)).length
    const at = (p: Png, x: number, y: number) => p.at(Math.floor(x * scale), Math.floor(y * scale))
    const second = add.lead.y + LH
    const gutterBg = at(png, bounds.x + 4, second + LH / 2)
    assert.ok(ink(png, gutter(add.lead.y), gutterBg) > 3, 'the line number paints on the first visual line')
    assert.equal(ink(png, gutter(second), gutterBg), 0, 'no number on the continuation line')
    const mid = (y: number) => y + LH / 2, gap = add.lead.x - 1.5 // the marker cell's empty right edge
    assert.deepEqual(at(png, bounds.x + 4, mid(second)), at(png, bounds.x + 4, mid(add.lead.y)), 'the gutter colour fills the continuation line')
    // The marker cell is empty on a continuation line, so it shows the row's own tint.
    const rgb = (c: string): number[] => c.startsWith('#') ? [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)) : c.match(/[\d.]+/g)!.slice(0, 3).map(n => Math.round(+n))
    const near = (p: number[], c: string, label: string) => assert.ok(rgb(c).every((v, i) => Math.abs(v - p[i]!) <= tolerance), `${label}: ${p.slice(0, 3)} vs ${c}`)
    near(at(png, gap, mid(second)), s.tints.add, 'the row tint fills the continuation line')
    near(at(png, gap, mid(add.next.y)), s.tints.bg, 'the next (context) row is untinted')

    // Line clicks: the continuation line and a stretched gutter target their own row.
    const clicks = async (x: number, y: number) => { await a.mouse.click({ x, y }); await a.clock.fastForward(32); return (await inspect()).clicks.at(-1) }
    assert.equal(await clicks(add.lead.x + 40, second + LH / 2), `old:- new:${s.numbers[3].new}`, 'click on a wrapped continuation line')
    assert.equal(await clicks(bounds.x + 8, del.lead.y + LH + LH / 2), `old:${s.numbers[6].old} new:-`, 'click on the old gutter beside a continuation line')
    assert.equal(await clicks(add.lead.x + 40, add.next.y + LH / 2), `old:${s.numbers[4].old} new:${s.numbers[4].new}`, 'the next row is its own line')

    // No horizontal scroller.
    await a.mouse.wheel({ x: bounds.x + 200, y: bounds.y + 120 }, -100000, 0); await a.clock.fastForward(64)
    s = await inspect()
    assert.equal(row(s, 3).lead.x, add.lead.x, 'a horizontal wheel does not move wrapped content')

    // A narrower diff re-measures its rows.
    await key('n'); s = await settled(inspect, s => !!rects(s, 'WRAPEND', 4) && row(s, 3).lines > add.lines)
    assert.ok(row(s, 3).lines > add.lines, 'narrowing wraps into more lines')
    await key('n'); s = await settled(inspect, s => !!rects(s, 'WRAPEND', 4) && row(s, 3).lines === add.lines)
    assert.equal(row(s, 3).lines, add.lines, 'widening restores the line count')

    // Unwrapped: one line per row, the old horizontal layout.
    await key('w'); s = await settled(inspect, s => !s.wrap && !!rects(s, 'export', 4))
    const flat = rects(s, 'export', 4)![0]!, flatNext = rects(s, 'short', 5)![0]!
    assert.ok(Math.abs(flatNext.y - flat.y - LH) < 1, 'unwrapped rows are one line height')
    await shot('unwrapped')
    await key('w'); s = await settled(inspect, s => s.wrap && !!rects(s, 'WRAPEND', 4))

    // Exact anchors inside a wrapped row: toggles keep the row, a remount restores the same pixels.
    const anchor = (actual: number[], expected: number[], label: string) => {
      assert.ok(actual, `${label}: missing live ListState`)
      assert.equal(actual[0], expected[0], `${label}: row index`)
      assert.ok(Math.abs(actual[1]! - expected[1]!) < 0.05, `${label}: ${actual[1]} != ${expected[1]} pixel offset`)
    }
    await key('j'); s = await inspect(); anchor(s.top, [124, 30.5], 'anchor on the second visual line of a wrapped row')
    await key('w'); s = await inspect(); assert.equal(s.top[0], 124, 'unwrapping keeps the anchored row')
    await key('w'); s = await inspect(); assert.equal(s.top[0], 124, 'wrapping again keeps the anchored row')
    await key('j'); await a.mouse.wheel({ x: bounds.x + 200, y: bounds.y + 120 }, 0, -173.25); await a.clock.fastForward(64)
    await key('s'); s = await inspect()
    const saved = s.saved as number[]
    assert.ok(saved[0]! > 124, 'a wheel moves past variable-height rows')
    const before = await capture(f, path.join(out, `${appearance}-anchor-before.png`))
    await key('h'); await key('m'); s = await inspect(); anchor(s.top, [0, 0], 'a remounted diff starts at the top')
    await key('r'); s = await inspect(); anchor(s.top, saved, 'restored anchor')
    const after = await capture(f, path.join(out, `${appearance}-anchor-restored.png`))
    assert.deepEqual(sample(pngPixels(after), scale, bounds, 2), sample(pngPixels(before), scale, bounds, 2), 'the restored wrapped diff paints the same pixels')

    // maxLines / Show more with wrapped rows.
    await key('t'); await key('x')
    await a.mouse.wheel({ x: bounds.x + 200, y: bounds.y + 120 }, 0, -1000000); await a.clock.fastForward(64)
    s = await settled(inspect, s => s.painted.some((t: string) => /^Show \d+ more lines$/.test(t)))
    assert.ok(s.painted.includes('Show 360 more lines'), 'Show more after 40 wrapped lines')
    await a.mouse.click({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height - 15 }); await a.clock.fastForward(64)
    s = await settled(inspect, s => s.maxLines === 80)
    assert.deepEqual(s.more, ['360'], 'Show more fired once'); assert.equal(s.clicks.length, 0, 'not as a line click')
    await a.mouse.wheel({ x: bounds.x + 200, y: bounds.y + 120 }, 0, -1000000); await a.clock.fastForward(64)
    s = await settled(inspect, s => s.painted.includes('Show 320 more lines'))
    assert.ok(s.highlights.some((h: Hl) => h.sub >= 75 && h.sub <= 80), 'the expanded wrapped rows are reachable')
    console.log(`ok ${appearance}: wrapped rows ${add.lines} lines with first-line numbers and full tints, line clicks, no horizontal scroll, width re-measure, unwrapped parity, exact anchors in a wrapped row across toggles/remount/restore, Show more`)
  } catch (error) { console.error(f.diagnostics()); throw error }
  finally { await f.close() }
}
