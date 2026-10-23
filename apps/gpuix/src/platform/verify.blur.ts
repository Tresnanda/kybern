// ADE-56/57/58 on screen: which surfaces blur what is behind them, plus captures of the surfaces whose material changed (composer
// trays, the transcript's bottom edge, the "…" menu, a dialog, the palette, a tooltip, the Notes / Tasks / Settings pages).
//
//   KYBERN_GLASS_WIDE=1 KYBERN_DATA_DIR=<…gpuix-scratch…/data> bun src/platform/verify.blur.ts <out-dir> <tag> [dark|light]
//
// The fixture is the glass thread (`perf/glass/`) with `KYBERN_GLASS_WIDE=1`, so text runs under every popup; the window is 1000×900,
// whole-window glass at 83/83 (the opacity the author runs). Each popup is captured with and without itself open and `showThrough`
// regresses its pixels on the scene behind it: `colour` (pixel gradients of GPUI's own render, colour divided by alpha: what a blur
// removes), `alpha` (the same in the window's alpha: what only a blur of the alpha removes) and, for a dialog's scrim, a calibration patch.
// Per state three images land in <out-dir>: `<tag>-<session>-<state>.png` (the OS window image; the window server often returns the
// previous frame, so it is retried and flagged), `.scene.png` (GPUI's own render, RGBA) and `.glass.png` (that render over a flat grey
// desktop, always fresh). Numbers: <out-dir>/<tag>-blur.json. Sessions: `blur` (whole-window glass; `KYBERN_BLUR_FROST=none` for tint
// only), `sidebar` and `solid` (states only, the pixel-equality sanity). Modes: `KYBERN_BLUR_QUICK=1` popups only (the reliable path for the
// numbers), `KYBERN_BLUR_POPUPS=0` states only, `KYBERN_BLUR_SESSIONS=blur,solid`. `NAPI_RS_NATIVE_LIBRARY_PATH` picks the addon.
import '../native/local-build.ts'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import path from 'node:path'
import { pixels } from '../../native/png.ts'
import { lease } from '../../perf/bench/lease.ts'
import { onExit } from '../../perf/bench/lifetime.ts'
import { waitForWindowOnscreen } from '../../perf/bench/window-onscreen.ts'
import { controlFor, ensureTestDisplay, waitForQuiet } from '../../perf/glass/harness.ts'
import { overBlack, luminance, type Box, type Image } from '../../perf/glass/pixels.ts'
import { seedGlass } from '../../perf/glass/seed.ts'
import { launchFixture } from '../requests/harness.ts'
import { assertScratchDataDir, until, windowId } from './verify.lib.ts'

assertScratchDataDir()
if (process.env.KYBERN_GLASS_WIDE !== '1') throw Error('Run with KYBERN_GLASS_WIDE=1 (the seed reads it at import).')
const GPUIX = path.resolve(import.meta.dir, '../..')
const [outArg, tag = 'run', theme = 'dark'] = process.argv.slice(2)
const variant = theme === 'light' ? 'light' : 'dark'
const OUT = path.resolve(outArg ?? '/Users/mymac/projects/ade/.kybern-artifacts/ade-54-58/L1')
const REPO = path.resolve(GPUIX, '../..')
if (OUT === REPO || OUT.startsWith(REPO + path.sep)) throw Error(`Refusing to write captures into the repository (${OUT})`)
mkdirSync(OUT, { recursive: true })

if (!(await waitForQuiet())) throw Error('Another agent\'s native build or check is still running after 20 minutes.')
const fixture = await seedGlass()
const unFixture = onExit(() => fixture.close())
const stopDisplay = await ensureTestDisplay(path.join(fixture.extras, 'bin'))
const unDisplay = onExit(stopDisplay)
const release = await lease()
const a11y = path.join(fixture.extras, 'a11y.json')
writeFileSync(a11y, '{}')

const PINS = ['KYBERN_WINDOW_MATERIAL', 'KYBERN_WINDOW_OPACITY', 'KYBERN_WINDOW_CONTENT_OPACITY', 'KYBERN_WINDOW_SURFACE_OPACITY', 'KYBERN_GLASS_FROST', 'KYBERN_GLASS_BASELINE', 'KYBERN_REDUCED_TRANSPARENCY', 'KYBERN_INCREASED_CONTRAST']
const settle = (ms = 900) => Bun.sleep(ms)

type App = Awaited<ReturnType<typeof launchFixture>>['app']
interface Shot { os: Image; scene: Image }
interface Ctx { app: App; control: Awaited<ReturnType<typeof controlFor>>; shot: (state: string) => Promise<Shot>; session: string }

/** Whether an OS window image shows the same frame as GPUI's own render: the correlation of their coarse luminance grids. */
function sameFrame(os: Image, scene: Image): boolean {
  if (os.w !== scene.w || os.h !== scene.h) return false
  const n = 48, a: number[] = [], b: number[] = []
  const lum = (img: Image, x: number, y: number) => { const i = (y * img.w + x) * img.channels, k = img.channels === 4 ? img.data[i + 3]! / 255 : 1; return luminance([img.data[i]! * k, img.data[i + 1]! * k, img.data[i + 2]! * k]) }
  for (let gy = 0; gy < n; gy++) for (let gx = 0; gx < n; gx++) { const x = Math.floor((gx + 0.5) * os.w / n), y = Math.floor((gy + 0.5) * os.h / n); a.push(lum(os, x, y)); b.push(lum(scene, x, y)) }
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length, ma = mean(a), mb = mean(b)
  let sab = 0, saa = 0, sbb = 0
  for (let i = 0; i < a.length; i++) { sab += (a[i]! - ma) * (b[i]! - mb); saa += (a[i]! - ma) ** 2; sbb += (b[i]! - mb) ** 2 }
  return saa > 0 && sbb > 0 && sab / Math.sqrt(saa * sbb) > 0.985
}

/** Straight-alpha GPUI render (colour stored premultiplied) composited over a flat desktop and written as an RGB PNG. */
const DESKTOP: readonly [number, number, number] = [128, 128, 128]
function writeOverDesktop(img: Image, file: string) {
  const row = img.w * 3 + 1, raw = Buffer.alloc(row * img.h)
  for (let y = 0; y < img.h; y++) {
    raw[y * row] = 0
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * img.channels, a = img.channels === 4 ? img.data[i + 3]! / 255 : 1
      for (let c = 0; c < 3; c++) raw[y * row + 1 + x * 3 + c] = Math.min(255, Math.round(img.data[i + c]! + DESKTOP[c]! * (1 - a)))
    }
  }
  const crc = (buf: Buffer) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) } return ~c >>> 0 }
  const chunk = (type: string, data: Buffer) => { const t = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); t.copy(out, 4); out.writeUInt32BE(crc(t), 8 + data.length); return out }
  const head = Buffer.alloc(13); head.writeUInt32BE(img.w, 0); head.writeUInt32BE(img.h, 4); head[8] = 8; head[9] = 2
  writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
}

type Plane = 'color' | 'alpha' | 'screen'
/**
 * One plane of a device-pixel rectangle, row-major. `color`: luminance of GPUI's own render with the colour divided by alpha
 * (its PNG holds premultiplied colour), so a surface's blur is read apart from the window's transparency. `alpha`: the window's
 * alpha. `screen`: luminance of the OS window image (the window-server composite).
 */
function lumRect(img: Image, x0: number, y0: number, x1: number, y1: number, plane: Plane): { w: number; h: number; v: Float32Array } {
  const w = Math.max(0, Math.min(img.w, x1) - Math.max(0, x0)), h = Math.max(0, Math.min(img.h, y1) - Math.max(0, y0))
  const v = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = ((Math.max(0, y0) + y) * img.w + Math.max(0, x0) + x) * img.channels, a = img.channels === 4 ? img.data[i + 3]! : 255
    if (plane === 'alpha') { v[y * w + x] = a; continue }
    const k = plane === 'color' && a > 0 ? 255 / a : 1
    v[y * w + x] = luminance([Math.min(255, img.data[i]! * k), Math.min(255, img.data[i + 1]! * k), Math.min(255, img.data[i + 2]! * k)])
  }
  return { w, h, v }
}
/** Least-squares slope of y on x (both centred): how much of x shows in y. */
function slope(xs: ArrayLike<number>, ys: ArrayLike<number>): number {
  let mx = 0, my = 0; const n = xs.length
  for (let i = 0; i < n; i++) { mx += xs[i]!; my += ys[i]! }
  mx /= n; my /= n
  let sxy = 0, sxx = 0
  for (let i = 0; i < n; i++) { sxy += (xs[i]! - mx) * (ys[i]! - my); sxx += (xs[i]! - mx) ** 2 }
  return sxx > 0 ? sxy / sxx : 0
}
/**
 * How much of the scene behind a rectangle shows through a surface painted over it, from the capture without the surface
 * (`behind`) and with it (`img`): `fine` is the slope of the surface's pixel gradients on the scene's (what a blur removes),
 * `coarse` the slope of 16 pt block means (what a translucent tint keeps and an opaque fill removes). A plain tint of alpha a
 * gives both ≈ 1 − a; a blurred tint gives `fine` ≈ 0 and `coarse` ≈ 1 − a; an opaque fill gives both ≈ 0.
 */
function showThrough(img: Image, behind: Image, rect: readonly [number, number, number, number], plane: Plane): { fine: number; coarse: number } {
  const P = lumRect(img, ...rect, plane), B = lumRect(behind, ...rect, plane)
  const gp: number[] = [], gb: number[] = []
  for (let y = 0; y < P.h - 1; y++) for (let x = 0; x < P.w - 1; x++) {
    const i = y * P.w + x
    gp.push(P.v[i + 1]! - P.v[i]!, P.v[i + P.w]! - P.v[i]!); gb.push(B.v[i + 1]! - B.v[i]!, B.v[i + B.w]! - B.v[i]!)
  }
  const bp: number[] = [], bb: number[] = [], blk = 32
  for (let y = 0; y + blk <= P.h; y += blk) for (let x = 0; x + blk <= P.w; x += blk) {
    let sp = 0, sb = 0
    for (let j = 0; j < blk; j++) for (let k = 0; k < blk; k++) { sp += P.v[(y + j) * P.w + x + k]!; sb += B.v[(y + j) * B.w + x + k]! }
    bp.push(sp / (blk * blk)); bb.push(sb / (blk * blk))
  }
  return { fine: slope(gb, gp), coarse: bp.length > 3 ? slope(bb, bp) : NaN }
}
const rectOf = (b: Box, inset: number, scale = 2) => [Math.round((b.x + inset) * scale), Math.round((b.y + inset) * scale), Math.round((b.x + b.width - inset) * scale), Math.round((b.y + b.height - inset) * scale)] as const

const results: Record<string, unknown>[] = []
const metrics: Record<string, { box: Box; colorFine: number; colorCoarse: number; alphaFine: number; screenFine: number }> = {}

const ONLY = process.env.KYBERN_BLUR_SESSIONS?.split(',')
async function session(label: string, pins: Record<string, string>, steps: (ctx: Ctx) => Promise<void>) {
  if (ONLY && !ONLY.includes(label)) return
  const client = path.join(fixture.extras, 'clients', `${label}-${variant}`)
  rmSync(client, { recursive: true, force: true }); mkdirSync(client, { recursive: true })
  const env: Record<string, string> = {
    ...fixture.env, ...Object.fromEntries(PINS.map((k) => [k, ''])), KYBERN_WINDOW_BLUR: '64',
    KYBERN_CLIENT_CONFIG_DIR: client, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(client, 'credentials'), KYBERN_GPUIX_ENVIRONMENT: 'local',
    KYBERN_GPUIX_THREAD: fixture.manifest.thread, KYBERN_GLASS_THREAD: fixture.manifest.thread, KYBERN_GLASS_EXPAND: `file:${fixture.manifest.editTurn}:${fixture.manifest.expandFile}`,
    GPUIX_BACKGROUND: '1', KYBERN_BENCH_LAYER_ZERO: '1', KYBERN_PACING_IGNORE_PHYSICAL_MOUSE: '1', KYBERN_APPEARANCE: variant, KYBERN_A11Y_FILE: a11y,
    KYBERN_REDUCED_MOTION: '', KYBERN_GLASS_WIDE: '1', KYBERN_WINDOW_SIZE: '1000x900',
    ...pins,
  }
  console.log(`\n── ${label} ${Object.entries(pins).map(([k, v]) => `${k.replace('KYBERN_', '')}=${v}`).join(' ')}`)
  const run = await launchFixture(path.join(GPUIX, 'perf/glass/app.ts'), env)
  try {
    await run.app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
    await waitForWindowOnscreen(run.pid, 60_000)
    const id = windowId(run.pid)
    const control = await controlFor(client)
    const ctx_park = async () => { await run.app.mouse.move({ x: 24 + Math.random() * 4, y: 640 }) }
    const shot = async (state: string) => {
      const os = path.join(OUT, `${tag}-${label}-${state}.png`), scene = path.join(OUT, `${tag}-${label}-${state}.scene.png`)
      // The window server can hand back the previous frame of a window that did not present since: capture again (after a
      // pointer nudge, which repaints) until the OS image shows what GPUI's own render shows.
      await control('render-capture', { path: scene })
      const rendered = pixels(scene) as Image
      for (let attempt = 0; attempt < 3; attempt++) {
        try { execFileSync('screencapture', ['-x', '-o', '-l', String(id), os]) } catch (e) { console.log(`screencapture failed: ${String(e).slice(0, 120)}`) }
        if (sameFrame(pixels(os) as Image, rendered)) break
        if (attempt === 2) console.log(`NOTE: ${tag}-${label}-${state}.png is a stale OS frame (it does not match GPUI's own render); the .scene.png is the frame`)
        await ctx_park(); await settle(500)
      }
      // Two captures per state: the OS window image (the window server's composite: what a person sees) and GPUI's own render of
      // the same frame (`render-capture`: RGBA with the window's alpha, the in-scene blur included). A frosted surface's blur
      // is read in the render's colour; its alpha keeps the scene's silhouettes (see the note at `verdict`).
      await control('render-capture', { path: scene })
      const sceneImg = pixels(scene) as Image
      // The same frame over a flat mid-grey desktop (`.glass.png`): always fresh, and the translucent window shows its alpha.
      writeOverDesktop(sceneImg, path.join(OUT, `${tag}-${label}-${state}.glass.png`))
      return { os: pixels(os) as Image, scene: sceneImg }
    }
    await steps({ app: run.app, control, shot, session: label })
  } catch (error) {
    console.log(`FAIL ${label}: ${String(error).slice(0, 500)}\n${run.diagnostics().split('\n').filter((l) => !l.includes('[pacing-commit]')).join('\n').slice(-800)}`)
    results.push({ session: label, error: String(error).slice(0, 300) })
  } finally { await run.close() }
}

const box = async (app: App, testId: string): Promise<Box | null> => {
  try { if ((await app.getByTestId(testId).count()) === 0) return null; const b = await app.getByTestId(testId).bounds(); return b.width > 0 ? b : null } catch { return null }
}
const park = (app: App) => app.mouse.move({ x: 24, y: 640 })
const F = fixture.manifest

async function openThread(ctx: Ctx) {
  const { app, control } = ctx
  await control('open-fixture-thread')
  await until(async () => { const s = await control<{ selected: string; loaded: boolean; blocks: number }>('state'); return s.selected === F.thread && s.loaded && s.blocks > 0 }, 'the thread loads', 30_000)
  await app.getByTestId('composer-drop-zone').waitFor({ timeoutMs: 30_000 })
  await park(app); await settle(1500)
}

/**
 * Scroll up from wherever the thread is until dense text (the fixture's long bullets) lies under the popups' boxes: the "…" menu's
 * corner and the middle of the column. Checked in GPUI's own render, so the popup is not yet open.
 */
async function denseText(ctx: Ctx) {
  const dense = async () => {
    const shot = await ctx.shot('probe'), img = shot.scene
    const rect = (x0: number, y0: number, x1: number, y1: number) => lumRect(img, x0 * 2, y0 * 2, x1 * 2, y1 * 2, 'color')
    const energy = (r: ReturnType<typeof rect>) => { let sum = 0, n = 0; for (let y = 0; y < r.h - 1; y++) for (let x = 0; x < r.w - 1; x++) { sum += Math.abs(r.v[y * r.w + x + 1]! - r.v[y * r.w + x]!); n++ } return n ? sum / n : 0 }
    return Math.min(energy(rect(710, 60, 900, 190)), energy(rect(400, 200, 700, 520)))
  }
  for (let i = 0; i < 40; i++) {
    if ((await dense()) > 6) return await settle(600)
    await ctx.control('scroll-up', { px: 160 }); await settle(500)
  }
  console.log('denseText: no dense text found under the popups; the numbers below are not valid')
}

/** Capture a popup: the scene before it opens, then with it open. The popup's cleanest strip against the same strip of the scene behind. */
async function popup(ctx: Ctx, name: string, testId: string, open: () => Promise<void>, close: () => Promise<void>) {
  const before = await ctx.shot(`${name}-behind`)
  await open()
  await ctx.app.getByTestId(testId).waitFor({ timeoutMs: 10_000 })
  await settle(1200)
  const b = await box(ctx.app, testId)
  const shot = await ctx.shot(name)
  if (b) {
    // A scrim (dialogs) dims everything: the same measure on a patch beside the card is what an unblurred, untinted card would show.
    const room = 1000 - (b.x + b.width), side = room > b.x ? { x: b.x + b.width + 8, y: b.y, width: Math.min(room - 16, 60), height: b.height } : { x: Math.max(4, b.x - 68), y: b.y, width: Math.min(b.x - 8, 60), height: b.height }
    const scrim = name === 'menu' || name === 'tooltip' || side.width < 24 ? null : showThrough(shot.scene, before.scene, rectOf(side as Box, 0), 'color')
    const unit = scrim && Number.isFinite(scrim.fine) && Math.abs(scrim.fine) > 0.05 ? scrim.fine : 1
    const color = showThrough(shot.scene, before.scene, rectOf(b, 8), 'color')
    const alpha = showThrough(shot.scene, before.scene, rectOf(b, 8), 'alpha')
    const screen = showThrough(shot.os, before.os, rectOf(b, 8), 'screen')
    metrics[`${ctx.session}:${name}`] = { box: b, colorFine: color.fine / unit, colorCoarse: color.coarse / unit, alphaFine: alpha.fine, screenFine: screen.fine / unit }
    console.log(`${ctx.session}:${name}  colour detail ${(color.fine / unit).toFixed(3)} (coarse ${(color.coarse / unit).toFixed(3)}), window-alpha detail ${alpha.fine.toFixed(3)}, on screen ${(screen.fine / unit).toFixed(3)}${scrim ? `, scrim ${scrim.fine.toFixed(2)}` : ''}`)
  } else console.log(`${ctx.session}:${name} popup not found`)
  await close()
  await settle(600)
}

/** A tooltip: hover the rail's settings button until it opens. */
async function tooltip(ctx: Ctx) {
  const { app } = ctx
  const trigger = await box(app, 'rail-settings')
  if (!trigger) return
  await app.mouse.move({ x: trigger.x + trigger.width / 2, y: trigger.y + trigger.height / 2 })
  await app.getByTestId('tooltip').waitFor({ timeoutMs: 6000 }).then(async () => { await settle(1000); await ctx.shot('tooltip') }).catch(() => console.log(`${ctx.session}: no tooltip opened`))
}

async function states(ctx: Ctx, withPopups: boolean) {
  const { app, control } = ctx
  const quick = process.env.KYBERN_BLUR_QUICK === '1' // popups only (iterating on the blur)
  if (quick) {
    await openThread(ctx); await denseText(ctx)
    const only = (process.env.KYBERN_BLUR_QUICK_POPUPS ?? 'menu,dialog,palette,tooltip').split(',')
    if (only.includes('menu')) await popup(ctx, 'menu', 'thread-actions-menu', async () => { await app.getByTestId('thread-actions').click() }, async () => { await app.getByTestId('app-ready').press('escape') })
    if (only.includes('dialog')) await popup(ctx, 'dialog', 'project-picker', async () => { await control('dialog') }, async () => { await control('dialog', { open: false }) })
    if (only.includes('palette')) await popup(ctx, 'palette', 'palette', async () => { await control('palette') }, async () => { await control('palette', { open: false }) })
    if (only.includes('tooltip')) await tooltip(ctx)
    return
  }
  // Home draft: the composer with the landing tray.
  await control('draft'); await app.getByTestId('composer-drop-zone').waitFor({ timeoutMs: 30_000 }); await park(app); await settle(1500)
  await ctx.shot('draft')
  // A task page: the run composer's tray.
  await control('task'); await app.getByTestId('task-send-open').waitFor({ timeoutMs: 30_000 }).catch(() => {}); await park(app); await settle(1500)
  await ctx.shot('task-closed')
  await app.getByTestId('task-send-open').click().catch(() => {}); await app.getByTestId('task-dock-tray').waitFor({ timeoutMs: 15_000 }).catch(() => {}); await park(app); await settle(1800)
  await ctx.shot('task')
  // Pages that sit directly on the glass: the lists and cards the audit looks at for opaque fills.
  if (process.env.KYBERN_BLUR_PAGES !== '0') {
    for (const page of ['notes', 'tasks']) { await control('page', { page }); await park(app); await settle(1500); await ctx.shot(`page-${page}`) }
    await control('settings'); await park(app); await settle(1500); await ctx.shot('page-settings'); await control('settings', { open: false }); await settle(600)
  }
  await openThread(ctx)
  await ctx.shot('thread-tail')
  await control('scroll-up', { px: 600 }); await settle(1200)
  await ctx.shot('thread-scrolled')
  if (!withPopups || process.env.KYBERN_BLUR_POPUPS === '0') return
  // Popups over dense text: further up the thread, where every line runs across the column.
  await denseText(ctx)
  await ctx.shot('thread-dense')
  await popup(ctx, 'menu', 'thread-actions-menu', async () => { await app.getByTestId('thread-actions').click() }, async () => { await app.getByTestId('app-ready').press('escape') })
  await popup(ctx, 'dialog', 'project-picker', async () => { await control('dialog') }, async () => { await control('dialog', { open: false }) })
  await popup(ctx, 'palette', 'palette', async () => { await control('palette') }, async () => { await control('palette', { open: false }) })
  await tooltip(ctx)
}

const glass = { KYBERN_WINDOW_MATERIAL: 'window', KYBERN_WINDOW_OPACITY: '83', KYBERN_WINDOW_CONTENT_OPACITY: '83', ...(process.env.KYBERN_BLUR_FROST ? { KYBERN_GLASS_FROST: process.env.KYBERN_BLUR_FROST } : {}) }
try {
  await session('blur', glass, (ctx) => states(ctx, true))
  await session('sidebar', { KYBERN_WINDOW_MATERIAL: 'sidebar', KYBERN_WINDOW_OPACITY: '90' }, (ctx) => states(ctx, false))
  await session('solid', { KYBERN_WINDOW_MATERIAL: 'solid' }, (ctx) => states(ctx, false))
} finally {
  release(); stopDisplay(); unDisplay()
  await fixture.close(); unFixture()
}

// Verdict. `colorFine` is the share of the scene's glyph edges that survives in the colour under the surface: a plain tint keeps
// them (≈ 1 − alpha of the tint), a blur or an opaque fill removes them. `alphaFine` is the same for the window's alpha channel.
// The addon's backdrop pass used to leave the destination alpha as it was (alpha factors Zero / One in `backdrop_renderer.rs`), so
// over a translucent window the desktop showed through the scene's silhouettes (opaque glyph pixels on a translucent coat) however
// well the colour was blurred: the "text ghost" on screen, alphaFine ≈ 0.33 for the "…" menu. The programmable-blend pass blurs
// the alpha with the colour (alphaFine ≈ 0). `KYBERN_BACKDROP_PROGRAMMABLE=0` brings the old pass back as the control.
const verdict: Record<string, unknown> = {}
for (const [key, m] of Object.entries(metrics)) {
  if (!key.startsWith('blur:')) continue
  const name = key.slice(5)
  // Whether a surface is translucent at all is a property of its fill (`glass.ts`), not read from pixels here: a blurred tint and an
  // opaque fill both leave no sharp detail in the colour. What the pixels settle is what is sharp.
  const colour = Math.abs(m.colorFine) > 0.03 ? 'scene detail sharp in the colour' : 'no sharp scene detail in the colour'
  const silhouette = Math.abs(m.alphaFine) > 0.03 ? ' + sharp silhouettes in the window alpha (the desktop shows them through)' : ''
  verdict[name] = { colorFine: +m.colorFine.toFixed(3), colorCoarse: +m.colorCoarse.toFixed(3), alphaFine: +m.alphaFine.toFixed(3), screenFine: +m.screenFine.toFixed(3), colour: colour + silhouette }
  console.log(`${name.padEnd(8)} colour ${m.colorFine.toFixed(3)} / coarse ${m.colorCoarse.toFixed(3)}  alpha ${m.alphaFine.toFixed(3)}  screen ${m.screenFine.toFixed(3)}  → ${colour}${silhouette}`)
}
writeFileSync(path.join(OUT, `${tag}-blur.json`), JSON.stringify({ tag, variant, verdict, metrics, results }, null, 2))
