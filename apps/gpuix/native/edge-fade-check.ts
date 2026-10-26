// Native `edgeFade` (N3, native/upstream/packages/native/src/edge_fade.rs + the fade link in rounded_clip.rs).
// On a transparent window the captured alpha of opaque content is the fade:
// at d px from a faded edge with ramp b it must be (d/b)² ± 0.02, for a quad, an
// image and glyphs (glyphs as a ratio to an unfaded copy); nested scopes multiply;
// insets cut; a scrolled scroller keeps its fade on the viewport; a row inside a
// retained translation (paintTranslate, no re-render) keeps its fade on the row,
// on screen and in a full render. Hit testing ignores fades.
import '../src/native/local-build.ts'
import { EDGE_FADE } from '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import path from 'node:path'
import { launchFixture } from '../src/requests/harness.ts'
import { pixels } from './png.ts'
import { acquirePreviewUiLock } from '../scripts/preview-ui-lock.ts'
const output = process.env.KYBERN_VERIFY_OUTPUT ?? path.join(import.meta.dir, 'build/edge-fade')
// The fixture never talks to a daemon; the harness still requires a scratch data dir outside ~/.kybern.
const scratch = process.env.KYBERN_EDGE_FADE_SCRATCH ?? path.join(process.env.TMPDIR ?? '/tmp', 'kybern-edge-fade-check')
mkdirSync(output, { recursive: true }); mkdirSync(scratch, { recursive: true })
assert.ok(EDGE_FADE, 'The addon must report capabilities.edgeFade (kybernCapabilities)')
/** RGBA PNG alpha reader (render_to_image and screencapture both write 8-bit RGBA). */
function alphaOf(file: string) {
  const png = readFileSync(file), chunks: Buffer[] = []; let w = 0, h = 0
  for (let at = 8; at < png.length;) { const n = png.readUInt32BE(at), kind = png.toString('ascii', at + 4, at + 8), data = png.subarray(at + 8, at + 8 + n); if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); assert.equal(data[8], 8); assert.equal(data[9], 6, `${file}: expected RGBA`) } if (kind === 'IDAT') chunks.push(data); at += 12 + n }
  const raw = inflateSync(Buffer.concat(chunks)), bpp = 4, stride = w * bpp, out = Buffer.alloc(h * stride)
  for (let y = 0; y < h; y++) { const filter = raw[y * (stride + 1)]!; for (let x = 0; x < stride; x++) { const a = x >= bpp ? out[y * stride + x - bpp]! : 0, b = y ? out[(y - 1) * stride + x]! : 0, c = y && x >= bpp ? out[(y - 1) * stride + x - bpp]! : 0, p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); const delta = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : pa <= pb && pa <= pc ? a : pb <= pc ? b : c; out[y * stride + x] = (raw[y * (stride + 1) + 1 + x]! + delta) & 255 } }
  return { w, h, alpha: (x: number, y: number) => out[(Math.floor(y) * w + Math.floor(x)) * 4 + 3]! / 255 }
}
type Box = { x: number; y: number; width: number; height: number }
type Alpha = ReturnType<typeof alphaOf>
const failures: string[] = [], rows: unknown[] = []
/** Mean alpha of the two device rows whose centres straddle `d` logical px inside the bottom edge `edge`. */
const bottomSample = (img: Alpha, scale: number, x: number, edge: number, d: number) => (img.alpha(x * scale, (edge - d) * scale - 1) + img.alpha(x * scale, (edge - d) * scale)) / 2
function expectNear(label: string, actual: number, expected: number) {
  rows.push({ label, actual: +actual.toFixed(4), expected: +expected.toFixed(4) })
  if (Math.abs(actual - expected) > 0.02) failures.push(`${label}: alpha ${actual.toFixed(4)}, expected ${expected.toFixed(4)} ± 0.02`)
}
const release = process.env.KYBERN_CLIP_LOCK_HELD ? () => {} : acquirePreviewUiLock()
try {
  const f = await launchFixture(path.join(import.meta.dir, 'edge-fade-lab.tsx'), { KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: path.join(scratch, 'client'), KYBERN_URL: '', KYBERN_TOKEN: '', GPUIX_BACKGROUND: '1' })
  try {
    const a = f.app; await a.getByTestId('app-ready').waitFor(); await Bun.sleep(300)
    const b: Record<string, Box> = {}
    for (const id of ['fade', 'reference', 'nested', 'inset', 'scroller', 'row', 'left']) b[id] = await a.getByTestId(id).bounds()
    const shot = path.join(output, 'full.png'); await a.screenshot({ path: shot })
    const img = alphaOf(shot), scale = img.w / 680
    const fade = b.fade!, ref = b.reference!, bottom = fade.y + fade.height
    for (const d of [0, 10, 20, 30, 40]) {
      const want = (d / 40) ** 2
      expectNear(`quad d=${d}`, bottomSample(img, scale, fade.x + 30, bottom, d), want)
      expectNear(`image d=${d}`, bottomSample(img, scale, fade.x + 100, bottom, d), want)
      // Glyphs: the faded copy over the unfaded one, at the solid pixel of that row.
      const y = (bottom - d) * scale - 1
      let best = -1, bestAlpha = 0
      for (let x = Math.ceil((ref.x + 140) * scale); x < (ref.x + 200) * scale; x++) { const v = img.alpha(x, y); if (v > bestAlpha) { bestAlpha = v; best = x } }
      // That row's centre is d + 0.25 logical px from the edge.
      if (bestAlpha >= 0.9) expectNear(`text d=${d}`, img.alpha(best - (ref.x - fade.x) * scale, y) / bestAlpha, Math.min(1, ((d + 0.25) / 40) ** 2))
      else rows.push({ label: `text d=${d}`, skipped: 'no solid glyph pixel on this row' })
      expectNear(`nested d=${d}`, bottomSample(img, scale, b.nested!.x + 100, b.nested!.y + 200, d), want * want)
    }
    assert.ok(rows.filter(r => String((r as { label: string }).label).startsWith('text') && 'actual' in (r as object)).length >= 3, 'Too few solid glyph rows to check text')
    // Inset 30 with a 20 px ramp: transparent below height − 30, ramp over the 20 px above it.
    const inset = b.inset!, insetBottom = inset.y + inset.height
    for (const [d, want] of [[10, 0], [25, 0], [40, 0.25], [45, 0.5625], [60, 1]] as const) expectNear(`inset d=${d}`, bottomSample(img, scale, inset.x + 100, insetBottom, d), want)
    // Left 40 and top 20: the minimum over the active edges.
    const left = b.left!
    for (const d of [10, 20, 30]) {
      const x = (left.x + d) * scale, y = (left.y + 60) * scale
      expectNear(`left d=${d}`, (img.alpha(x - 1, y) + img.alpha(x, y)) / 2, (d / 40) ** 2)
    }
    expectNear('left+top corner', img.alpha((left.x + 30) * scale, (left.y + 5) * scale + 0.5), Math.min(30.5 / 40, 5.25 / 20) ** 2)
    // Hit testing ignores fades: the nearly transparent bottom row still hits the element.
    await a.mouse.click({ x: fade.x + 30, y: bottom - 1 })
    assert.equal(await a.getByTestId('hit').textContent(), 'fade', 'a faded pixel must stay interactive')
    // A scrolled scroller keeps its fade on the viewport.
    const scroller = b.scroller!
    await a.getByTestId('scroller').wheel(0, -120); await Bun.sleep(200)
    const scrolledShot = path.join(output, 'scrolled.png'); await a.screenshot({ path: scrolledShot })
    const scrolled = alphaOf(scrolledShot)
    const probe = (file: string) => pixels(file).at((scroller.x + 100) * scale, (scroller.y + 30) * scale).join()
    assert.notEqual(probe(scrolledShot), probe(shot), 'the scroller must have scrolled')
    for (const d of [0, 10, 20, 30, 40]) expectNear(`scroller d=${d}`, bottomSample(scrolled, scale, scroller.x + 100, scroller.y + scroller.height, d), (d / 40) ** 2)
    // Retained translation: move the row without a render, then compare its alpha on screen with a full render.
    await a.call('focus', { elementId: (await a.getByTestId('app-ready').element()).id })
    await a.call('keyDown', { key: 's' }); await Bun.sleep(300)
    const row = await a.getByTestId('row').bounds()
    assert.equal(row.y, b.row!.y - 60, 'the row must follow its retained translation')
    const fullShot = path.join(output, 'translated-full.png'); await a.screenshot({ path: fullShot })
    const full = alphaOf(fullShot)
    for (const d of [0, 10, 20, 30, 40]) expectNear(`translated row (render) d=${d}`, bottomSample(full, scale, row.x + 100, row.y + row.height, d), (d / 40) ** 2)
    let windowId = ''
    try { windowId = execFileSync('swift', [path.join(import.meta.dir, '../src/tasks/round7-window-id.swift'), String(f.pid)], { encoding: 'utf8' }).trim() } catch {}
    if (windowId) {
      // The screenshot above re-rendered; translate back and forth so the presented scene is the retained one.
      await a.call('keyDown', { key: 'u' }); await Bun.sleep(150); await a.call('keyDown', { key: 's' }); await Bun.sleep(300)
      const screen = path.join(output, 'translated-screen.png')
      try { execFileSync('screencapture', ['-x', '-o', '-l', windowId, screen]) } catch { windowId = '' }
      if (windowId) {
        const captured = alphaOf(screen), s = captured.w / 680, top = captured.h / s - 560
        for (const d of [0, 10, 20, 30, 40]) expectNear(`translated row (screen) d=${d}`, bottomSample(captured, s, row.x + 100, row.y + row.height + top, d), (d / 40) ** 2)
      }
    }
    if (!windowId) rows.push({ label: 'translated row (screen)', skipped: 'screencapture of the window unavailable' })
    writeFileSync(path.join(output, 'results.json'), JSON.stringify({ rows, failures }, null, 2))
    for (const r of rows) console.log(JSON.stringify(r))
    assert.deepEqual(failures, [])
    console.log('ok edge fade: quad, image and glyph ramps, nested multiply, inset cut, left/top minimum, hit testing, scrolled scroller, retained translation')
  } catch (e) { console.error(f.diagnostics().slice(-3000)); throw e } finally { await f.close() }
} finally { release() }
