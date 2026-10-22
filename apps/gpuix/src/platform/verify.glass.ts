// Window translucency round 2 (layered glass), on screen: spec `docs/specs/gpuix-translucency-r2.md` §10.2 #1–#10 with
// real window captures (`screencapture -l <id> -o`) of the unchanged app on the glass fixture (`perf/glass/`): a thread
// with a clamped inbound message, an "Edited 3 files" card with one file open, the view 600 px up (scroll pill shown), and
// the model picker open in one capture.
//
//   KYBERN_DATA_DIR=<…gpuix-scratch…/data> bun src/platform/verify.glass.ts <out-dir> <dark|light>
//
// Black and white desktops: the capture keeps the window's own alpha, so each sample is composited over black and over
// white analytically (`perf/glass/pixels.ts`) instead of putting backing windows behind the app. The in-scene frost blur is
// inside the window's pixels, so it is captured. Translucent = the two composites differ by ≥ 3; opaque = they are equal.
//
// #1 compares Solid against round 1: the same fixture run with the app sources of `KYBERN_GLASS_BASELINE` (default
// f6cabebc2, the commit before round 2) served from git (`perf/glass/baseline.ts`). `KYBERN_GLASS_BASELINE=tokens` skips
// that launch and compares the frame, panel and content against the Solid theme tokens ±2 instead.
//
// Every capture lands in <out-dir>; the named ones are also copied to `$KYBERN_GLASS_SHOTS` (default
// /Users/mymac/projects/ade/.kybern-artifacts/ade-grill) as `r2-<state>-<variant>.png`. Results: <out-dir>/glass-<variant>.json.
import '../native/local-build.ts'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pixels } from '../../native/png.ts'
import { lease } from '../../perf/bench/lease.ts'
import { onExit } from '../../perf/bench/lifetime.ts'
import { waitForWindowOnscreen } from '../../perf/bench/window-onscreen.ts'
import { controlFor, ensureTestDisplay, waitForQuiet } from '../../perf/glass/harness.ts'
import {
  blackWhiteDelta, clampBandPoints, deltaOnBoth, diffFraction, fmt, leftInterior, leftRimDevice, luminance, medianPixel, devicePixel,
  overBlack, overWhite, parseCss, regionStack, segmentedPoints, stack, type Box, type Image, type Rgba,
} from '../../perf/glass/pixels.ts'
import { seedGlass } from '../../perf/glass/seed.ts'
import { launchFixture } from '../requests/harness.ts'
import { THEMES, materialFor, type GlassTokens } from '../theme.ts'
import { backdropAllowed } from './material.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { frostedWith } from './glass.ts'
import { parseFrostClasses, type FrostClass } from './translucency.ts'
import { assertScratchDataDir, until, windowId } from './verify.lib.ts'

assertScratchDataDir()
const GPUIX = path.resolve(import.meta.dir, '../..')
const REPO = path.resolve(GPUIX, '../..')
const [outArg, theme = 'dark'] = process.argv.slice(2)
const variant = theme === 'light' ? 'light' : 'dark'
const OUT = path.resolve(outArg ?? path.join(process.env.KYBERN_DATA_DIR!, '..', 'glass-captures'))
const SHOTS = path.resolve(process.env.KYBERN_GLASS_SHOTS ?? '/Users/mymac/projects/ade/.kybern-artifacts/ade-grill')
for (const dir of [OUT, SHOTS]) if (dir === REPO || dir.startsWith(REPO + path.sep)) throw Error(`Refusing to write captures into the repository (${dir})`)
const BASELINE = process.env.KYBERN_GLASS_BASELINE ?? 'f6cabebc2'
mkdirSync(OUT, { recursive: true }); mkdirSync(SHOTS, { recursive: true })

// ─── Results ─────────────────────────────────────────────────────────────────────────────────────────────────────────

type Status = 'ok' | 'FAIL' | 'info' | 'skip'
const results: { id: string; status: Status; detail: string }[] = []
const record = (id: string, status: Status, detail: string) => { results.push({ id, status, detail }); console.log(`${status.padEnd(4)} ${id}: ${detail}`) }
const check = (id: string, ok: boolean, detail: string) => record(id, ok ? 'ok' : 'FAIL', detail)
const both = (p: Rgba | null | undefined) => p ? `${fmt(overBlack(p))}/${fmt(overWhite(p))} a=${Math.round(p[3])}` : 'n/a'

// ─── Fixture, display, lease ─────────────────────────────────────────────────────────────────────────────────────────

if (!(await waitForQuiet())) throw Error('Another agent\'s native build or check is still running after 20 minutes; the live run is pending.')
const fixture = await seedGlass()
const unFixture = onExit(() => fixture.close())
const stopDisplay = await ensureTestDisplay(path.join(fixture.extras, 'bin'))
const unDisplay = onExit(stopDisplay)
const release = await lease()
const a11y = path.join(fixture.extras, 'a11y.json')
writeFileSync(a11y, '{}')

// ─── Sessions ────────────────────────────────────────────────────────────────────────────────────────────────────────

type App = Awaited<ReturnType<typeof launchFixture>>['app']
interface Shot { name: string; img: Image; file: string; boxes: Record<string, Box | null>; os?: Image }
interface Ctx { app: App; shot: (name: string, named?: string) => Promise<Image & { file: string; os: Image & { file: string } }>; control: Awaited<ReturnType<typeof controlFor>>; frost: ReadonlySet<FrostClass> }
const PINS = ['KYBERN_WINDOW_MATERIAL', 'KYBERN_WINDOW_OPACITY', 'KYBERN_WINDOW_CONTENT_OPACITY', 'KYBERN_WINDOW_SURFACE_OPACITY', 'KYBERN_GLASS_FROST', 'KYBERN_GLASS_BASELINE', 'KYBERN_REDUCED_TRANSPARENCY', 'KYBERN_INCREASED_CONTRAST']
const settle = (ms = 700) => Bun.sleep(ms)

const ONLY = process.env.KYBERN_GLASS_ONLY?.split(',').map((s) => s.trim()).filter(Boolean)
async function session(label: string, pins: Record<string, string>, steps: (ctx: Ctx) => Promise<void>) {
  if (ONLY && !ONLY.includes(label)) return
  const client = path.join(fixture.extras, 'clients', `${label}-${variant}`)
  rmSync(client, { recursive: true, force: true }); mkdirSync(client, { recursive: true })
  const env: Record<string, string> = {
    ...fixture.env, ...Object.fromEntries(PINS.map((k) => [k, ''])), KYBERN_WINDOW_BLUR: '64',
    KYBERN_CLIENT_CONFIG_DIR: client, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(client, 'credentials'), KYBERN_GPUIX_ENVIRONMENT: 'local',
    KYBERN_GPUIX_THREAD: fixture.manifest.thread, KYBERN_GLASS_THREAD: fixture.manifest.thread, KYBERN_GLASS_EXPAND: `file:${fixture.manifest.editTurn}:${fixture.manifest.expandFile}`,
    // Level 0: `windowId` (`screencapture -l`) looks for the normal-layer window; pacing-app floats it at level 3 otherwise.
    GPUIX_BACKGROUND: '1', KYBERN_BENCH_LAYER_ZERO: '1', KYBERN_PACING_IGNORE_PHYSICAL_MOUSE: '1', KYBERN_APPEARANCE: variant, KYBERN_A11Y_FILE: a11y, KYBERN_REDUCED_MOTION: '1',
    ...pins,
  }
  console.log(`\n── ${label} (${variant}) ${Object.entries(pins).map(([k, v]) => `${k.replace('KYBERN_', '')}=${v}`).join(' ')}`)
  const run = await launchFixture(path.join(GPUIX, 'perf/glass/app.ts'), env)
  try {
    await run.app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
    await waitForWindowOnscreen(run.pid, 60_000)
    const id = windowId(run.pid)
    const control = await controlFor(client)
    // Two captures per state: the OS window image (`screencapture -l -o`, what a person sees, with the window-server blur of
    // the test display's desktop composited in) for the screenshots, and GPUI's own render of the same frame, which keeps the
    // window's alpha (and the in-scene frost blur) for the black/white compositing. Measurements read the second.
    const shot = async (name: string, named?: string) => {
      const os = path.join(OUT, `${label}-${name}-${variant}.png`), scene = path.join(OUT, `${label}-${name}-${variant}.scene.png`)
      execFileSync('screencapture', ['-x', '-o', '-l', String(id), os])
      if (named) copyFileSync(os, path.join(SHOTS, `r2-${named}-${variant}.png`))
      await control('render-capture', { path: scene })
      // GPUI writes its capture with premultiplied colour in a straight-alpha PNG (a coat at 70% reads 13 for 19, at 90% 17
      // for 19; the screen agrees with the straight colour), so the colour is divided by alpha once here.
      const img = pixels(scene)
      if (img.channels === 4) for (let i = 0; i < img.data.length; i += 4) { const a = img.data[i + 3]!; if (a > 0 && a < 255) for (let c = 0; c < 3; c++) img.data[i + c] = Math.min(255, Math.round(img.data[i + c]! * 255 / a)) }
      return { ...img, file: scene, os: { ...pixels(os), file: os } }
    }
    await steps({ app: run.app, shot, control, frost: parseFrostClasses(pins.KYBERN_GLASS_FROST || undefined) })
  } catch (error) {
    // What the window showed when the step failed, and the element types inside the edited-files card.
    let where = ''
    try { const id = windowId(run.pid), file = path.join(OUT, `${label}-failure-${variant}.png`); execFileSync('screencapture', ['-x', '-o', '-l', String(id), file]); where = ` (capture: ${file})` } catch {}
    try {
      const types = new Set<string>(); const walk = (n: { type: string; testId?: string; children?: unknown[] }) => { types.add(n.testId ? `${n.type}#${n.testId}` : n.type); for (const c of n.children ?? []) walk(c as never) }
      walk(await run.app.getByTestId('edited-files').element() as never); where += `; edited-files holds ${[...types].slice(0, 60).join(' ')}`
    } catch {}
    record(`session ${label}`, 'FAIL', `${String(error).slice(0, 600)}${where}\n${run.diagnostics().split('\n').filter((l) => !l.includes('[pacing-commit]')).join('\n').slice(-1500)}`)
  } finally {
    await run.close()
  }
}

async function box(app: App, testId: string): Promise<Box | null> {
  try { if ((await app.getByTestId(testId).count()) === 0) return null; const b = await app.getByTestId(testId).bounds(); return b.width > 0 && b.height > 0 ? b : null } catch { return null }
}
async function typeBox(app: App, type: string): Promise<Box | null> {
  try { if ((await app.getByType(type).count()) === 0) return null; const b = await app.getByType(type).bounds(); return b.width > 0 && b.height > 0 ? b : null } catch { return null }
}
/** A blank spot for the pointer: the rail strip under its buttons (no hover anywhere). */
const NEUTRAL = { x: 24, y: 640 }
const park = (app: App) => app.mouse.move(NEUTRAL)

// ─── The thread fixture ──────────────────────────────────────────────────────────────────────────────────────────────

const F = fixture.manifest
async function threadBoxes(app: App) {
  const boxes: Record<string, Box | null> = {}
  for (const [k, id] of [['surface', 'transcript-surface'], ['inbound', 'inbound-message'], ['clamped', 'clamped-markdown'], ['edited', 'edited-files'], ['editedPanel', 'edited-files-panel'], ['toggle', 'edited-files-toggle'], ['composer', 'composer-drop-zone'], ['pill', 'scroll-to-bottom'], ['picker', 'model-picker'], ...F.files.map((f, i) => [`file${i}`, `edited-file-${f}`])] as const) boxes[k] = await box(app, id)
  boxes.diff = await typeBox(app, 'diff')
  return boxes
}
/** The thread: loaded, file open, a capture at the tail, one 600 px up with the pill, and (optionally) one with the model picker open. */
async function thread(ctx: Ctx, state: string, opts: { menu?: boolean; named?: string } = {}) {
  const { app, control } = ctx
  await until(async () => { const s = await control<{ selected: string; loaded: boolean; blocks: number }>('state'); return s.selected === F.thread && s.loaded && s.blocks > 0 }, 'the fixture thread loads', 30_000)
    .catch(async () => { await control('open-fixture-thread'); await until(async () => { const s = await control<{ loaded: boolean; blocks: number }>('state'); return s.loaded && s.blocks > 0 }, 'the fixture thread loads after open', 30_000) })
  await app.getByTestId('composer-drop-zone').waitFor({ timeoutMs: 30_000 })
  await park(app)
  await settle(1500)
  const tailImg = await ctx.shot(`${state}-tail`)
  const tail: Shot = { name: `${state}-tail`, img: tailImg, file: tailImg.file, boxes: await threadBoxes(app) }
  writeFileSync(`${tailImg.file}.boxes.json`, JSON.stringify(tail.boxes))
  const scroll = await control<{ before: number[] | null; after: number[] | null }>('scroll-up', { px: 600 })
  // Spec: the pill shows 600 px up. If it does not, record that and keep scrolling in 25 px steps (up to 600 more) so the
  // glass checks still run; the distance where it appears is reported.
  let extra = 0
  const pillShown = async () => { try { await app.getByTestId('scroll-to-bottom').waitFor({ timeoutMs: extra ? 400 : 2500 }); return true } catch { return false } }
  while (!(await pillShown()) && extra < 600) { await control('scroll-up', { px: 25 }); extra += 25 }
  const where = await control<{ after: number[] | null; surface: Box; bottomSpace: Box | null }>('scroll-state')
  record(`${state} scroll pill at 600 px`, extra === 0 ? 'ok' : 'info', `${extra === 0 ? 'shown' : `NOTE: not shown at 600 px; it appeared after ${600 + extra} px`} (list offset ${JSON.stringify(where.after)}, surface ${JSON.stringify(where.surface)}, bottom spacer ${JSON.stringify(where.bottomSpace)})`)
  if (extra >= 600) throw Error('The scroll pill never appeared')
  await app.getByTestId('edited-files').waitFor({ timeoutMs: 30_000 })
  await until(async () => !!(await typeBox(app, 'diff')), 'the open file shows its diff', 15_000)
  await park(app)
  await settle(1500)
  const img = await ctx.shot(state, opts.named)
  const scrolled: Shot = { name: state, img, file: img.file, boxes: await threadBoxes(app), os: img.os }
  writeFileSync(`${img.file}.boxes.json`, JSON.stringify(scrolled.boxes))
  record(`${state} scroll`, 'info', `offset ${JSON.stringify(scroll.before)} → ${JSON.stringify(scroll.after)}; pill ${scrolled.boxes.pill ? 'shown' : 'missing'}; inbound ${scrolled.boxes.inbound ? 'in view' : 'missing'}; edited ${scrolled.boxes.edited ? 'in view' : 'missing'}`)
  let menu: Shot | null = null
  if (opts.menu) {
    await app.getByTestId('model-picker').click()
    await app.getByTestId('model-picker-panel').waitFor({ timeoutMs: 10_000 })
    await settle(1000)
    const m = await ctx.shot(`${state}-menu`, opts.named ? `${opts.named}-menu` : undefined)
    menu = { name: `${state}-menu`, img: m, file: m.file, boxes: { ...scrolled.boxes, panel: await box(app, 'model-picker-panel') } }
    writeFileSync(`${m.file}.boxes.json`, JSON.stringify(menu.boxes))
    // Close it and make sure it is gone: a menu left open would cover the later captures' samples.
    await app.getByTestId('app-ready').press('escape')
    await settle(400)
    if ((await app.getByTestId('model-picker-panel').count()) > 0) { await app.getByTestId('model-picker').click(); await settle(400) }
    await until(async () => (await app.getByTestId('model-picker-panel').count()) === 0, 'the model menu closes', 5000)
    await settle(300)
  }
  return { tail, scrolled, menu }
}

/** Fixed points: the rail strip, the thread panel below its rows, and the conversation's blank right margin. */
function regions(s: Shot) {
  const sf = s.boxes.surface
  const margin = sf ? { x: sf.x + sf.width - Math.max(12, (sf.width - 736) / 4), y: sf.y + sf.height * 0.3 } : { x: 1250, y: 700 }
  return { frame: medianPixel(s.img, NEUTRAL.x, NEUTRAL.y), panel: medianPixel(s.img, 150, 700), content: medianPixel(s.img, margin.x, margin.y) }
}
const inView = (s: Shot, b: Box | null | undefined): b is Box => {
  const sf = s.boxes.surface, top = sf?.y ?? 0, bottom = s.boxes.composer?.y ?? (sf ? sf.y + sf.height : Infinity)
  return !!b && b.y >= top && b.y + b.height <= bottom
}
/** The bottom of a box (its last 80 points, where the fade band would be) is on screen even if its top is scrolled just above the view. */
const bottomInView = (s: Shot, b: Box | null | undefined): b is Box => {
  const sf = s.boxes.surface, top = sf?.y ?? 0, bottom = s.boxes.composer?.y ?? (sf ? sf.y + sf.height : Infinity)
  return !!b && b.y + b.height - 80 >= top && b.y + b.height <= bottom
}
/** The content-area samples (cards, diff, composer, pill) of a thread capture. */
function cardSamples(s: Shot) {
  const b = s.boxes, out: Record<string, Rgba | null> = {}
  out.inboundAbove = inView(s, b.clamped) ? medianPixel(s.img, clampBandPoints(b.clamped).above[0]!.x, clampBandPoints(b.clamped).above[0]!.y) : null
  out.inboundBand = inView(s, b.clamped) ? medianPixel(s.img, clampBandPoints(b.clamped).band[1]!.x, clampBandPoints(b.clamped).band[1]!.y) : null
  const header = b.edited && b.editedPanel ? { x: b.edited.x + b.edited.width / 2, y: (b.edited.y + b.editedPanel.y) / 2 } : null
  out.header = header && inView(s, b.edited) ? medianPixel(s.img, header.x, header.y) : null
  const row = b.file2
  out.body = row && b.edited && inView(s, row) ? medianPixel(s.img, b.edited.x + b.edited.width / 2, row.y + row.height / 2) : null
  out.diff = b.diff && inView(s, b.diff) ? medianPixel(s.img, b.diff.x + b.diff.width - 16, b.diff.y + b.diff.height / 2) : null
  out.composer = b.composer ? medianPixel(s.img, leftInterior(b.composer, 6).x, leftInterior(b.composer, 6).y) : null
  out.pill = b.pill ? medianPixel(s.img, leftInterior(b.pill, 5).x, leftInterior(b.pill, 5).y) : null
  return out
}
function settingsSamples(s: Shot) {
  const seg = s.boxes.segSolid && s.boxes.segTranslucent ? s.boxes : null
  const track = s.boxes.track
  return {
    card: track ? medianPixel(s.img, track.x + track.width / 2, track.y - 5) : null,
    page: track ? medianPixel(s.img, track.x + track.width + 40, track.y + track.height / 2) : null,
    ...(seg ? segmented(s) : {}),
  }
}
function segmented(s: Shot) {
  const translucentSelected = s.boxes.selected === s.boxes.segTranslucent
  const sel = translucentSelected ? s.boxes.segTranslucent! : s.boxes.segSolid!, un = translucentSelected ? s.boxes.segSolid! : s.boxes.segTranslucent!
  const p = segmentedPoints(sel, un, 10)
  const thumb = medianPixel(s.img, p.thumb.x, p.thumb.y), trackPad = medianPixel(s.img, p.trackPad.x, p.trackPad.y)
  // Between the segments: walk from the thumb's padding toward the other segment until the pixels are bare track again
  // (layout bounds and paint can differ by a few points, so the 2 pt gap is found in the pixels, not from the bounds).
  const dir = un.x < sel.x ? -1 : 1, y = Math.floor(p.thumb.y * 2)
  let trackGap: Rgba | null = null
  for (let x = Math.floor(p.thumb.x * 2), steps = 0; steps < 60; x += dir, steps++) {
    const px = devicePixel(s.img, x, y)
    if (deltaOnBoth(px, trackPad) <= 2) { trackGap = devicePixel(s.img, x + dir, y); break }
  }
  return { thumb, trackPad, trackGap }
}
async function appearance(ctx: Ctx, label: string, opts: { advanced?: 'open' | 'closed' | 'both'; named?: string; material?: 'solid' | 'translucent' } = {}) {
  const { app } = ctx
  if ((await app.getByTestId(`settings-window-${variant}-solid`).count()) === 0) {
    await app.getByTestId('rail-settings').click()
    await app.getByTestId('settings-tab-appearance').click()
    await app.getByTestId(`settings-window-${variant}-solid`).waitFor({ timeoutMs: 10_000 })
  }
  await park(app)
  await settle(900)
  const shots: Shot[] = []
  const take = async (name: string, named?: string) => {
    await park(app); await settle(700)
    const img = await ctx.shot(name, named)
    const boxes: Record<string, Box | null> = {
      track: await box(app, `settings-window-${variant}`), segSolid: await box(app, `settings-window-${variant}-solid`), segTranslucent: await box(app, `settings-window-${variant}-translucent`),
      advanced: await box(app, `settings-advanced-${variant}`),
    }
    const selected = opts.material ?? ((await box(app, `settings-sidebar-only-${variant}`)) ? 'translucent' : 'solid')
    boxes.selected = selected === 'translucent' ? boxes.segTranslucent : boxes.segSolid
    shots.push({ name, img, file: img.file, boxes })
    writeFileSync(`${img.file}.boxes.json`, JSON.stringify(boxes))
  }
  const isOpen = async () => (await app.getByTestId(`settings-sidebar-opacity-${variant}`).count()) > 0
  const advancedRow = (await app.getByTestId(`settings-advanced-${variant}`).count()) > 0
  if (!advancedRow || !opts.advanced) { await take(label, opts.named); return shots }
  for (const want of opts.advanced === 'both' ? ['closed', 'open'] as const : [opts.advanced]) {
    if ((await isOpen()) !== (want === 'open')) { await app.getByTestId(`settings-advanced-${variant}`).click(); await settle(600) }
    // Bring the Advanced rows into view (the page scrolls; a positive wheel delta goes up).
    const row = await box(app, `settings-advanced-${variant}`)
    if (want === 'open' && row && row.y > 200) { await app.mouse.wheel({ x: row.x + row.width / 2, y: 400 }, 0, -(row.y - 140)); await settle(500) }
    await take(`${label}-advanced-${want}`, opts.named ? `${opts.named}-advanced-${want}` : undefined)
  }
  return shots
}

// ─── Expected values ─────────────────────────────────────────────────────────────────────────────────────────────────

const T = THEMES[variant]
const G = (s = 90, c = 90): GlassTokens => materialFor(variant, 'window', s, c).glass
const frostedNow = (frost: ReadonlySet<FrostClass>, c: FrostClass) => frostedWith(true, backdropAllowed(), PATCHED_NATIVE, frost, c)
const solidTokens = (() => { const m = materialFor(variant, 'none', 100); return { frame: parseCss(m.frame), panel: parseCss(m.panel), content: parseCss(T.content) } })()

// ─── Run ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

type Samples = Record<string, Rgba | null>
const solid: { thread?: Samples; tail?: Samples; settings?: Samples; img?: Image } = {}
const r1: { thread?: Samples; tail?: Samples; settings?: Samples; img?: Image } = {}
const flat = (t: { tail: Shot; scrolled: Shot }) => ({ thread: { ...regions(t.scrolled), ...cardSamples(t.scrolled) }, tail: { ...regions(t.tail), ...cardSamples(t.tail) } })
const compareSamples = (id: string, got: Samples, want: Samples | undefined, by: number, keys = want ? Object.keys(want) : []) => {
  if (!want) return record(id, 'skip', 'no reference capture (its session did not run or failed)')
  const rows = keys.filter((k) => got[k] && want[k]).map((k) => ({ k, d: deltaOnBoth(got[k]!, want[k]!), g: got[k]!, w: want[k]! }))
  const missing = keys.filter((k) => !got[k] || !want[k])
  const worst = rows.reduce((m, r) => Math.max(m, r.d), 0)
  check(id, rows.length > 0 && worst <= by, `${rows.length} samples, worst Δ ${worst.toFixed(1)} (±${by})${rows.filter((r) => r.d > by).map((r) => `; ${r.k} ${both(r.g)} vs ${both(r.w)}`).join('')}${missing.length ? `; not sampled: ${missing.join(', ')}` : ''}`)
}

try {
  // #1 reference: round 1 on the same fixture.
  if (BASELINE !== 'tokens') {
    await session('r1-solid', { KYBERN_WINDOW_MATERIAL: 'solid', KYBERN_GLASS_BASELINE: BASELINE }, async (ctx) => {
      const t = await thread(ctx, 'thread', { menu: true, named: 'thread-r1-solid' })
      Object.assign(r1, flat(t), { img: t.scrolled.img })
      const [s] = await appearance(ctx, 'settings')
      r1.settings = settingsSamples(s!)
    })
  }

  await session('solid', { KYBERN_WINDOW_MATERIAL: 'solid' }, async (ctx) => {
    const t = await thread(ctx, 'thread', { menu: true, named: 'thread-solid' })
    Object.assign(solid, flat(t), { img: t.scrolled.img })
    const [s] = await appearance(ctx, 'settings', { named: 'settings-solid', material: 'solid' })
    solid.settings = settingsSamples(s!)
    const seg = solid.settings as Record<string, Rgba | null>
    if (seg.thumb && seg.trackGap) record('2 (Solid reference) thumb vs track', 'info', `ΔL ${(luminance(overBlack(seg.thumb)) - luminance(overBlack(seg.trackGap))).toFixed(1)}`)
  })
  if (r1.thread && solid.thread) {
    compareSamples('1 Solid thread vs round 1', solid.thread, r1.thread, 2)
    compareSamples('1 Solid thread at tail vs round 1', solid.tail ?? {}, r1.tail, 2)
    compareSamples('1 Solid settings vs round 1', solid.settings ?? {}, r1.settings, 2)
    const frac = diffFraction(solid.img!, r1.img!, 2)
    record('1 Solid whole-window pixels vs round 1', 'info', frac === null ? 'sizes differ' : `${(frac * 100).toFixed(3)}% of pixels differ by more than 2`)
  } else if (solid.thread) {
    record('1 Solid vs round 1', 'skip', BASELINE === 'tokens' ? 'KYBERN_GLASS_BASELINE=tokens' : 'the round-1 launch failed (see its session line); comparing with the Solid tokens')
    compareSamples('1 Solid vs tokens', { frame: solid.thread.frame!, panel: solid.thread.panel!, content: solid.thread.content! }, solidTokens, 2)
  }

  // Whole window, 90/90, default frost classes (menus).
  await session('window', { KYBERN_WINDOW_MATERIAL: 'window', KYBERN_WINDOW_OPACITY: '90' }, async (ctx) => {
    const g = G()
    const t = await thread(ctx, 'thread', { menu: true, named: 'thread-window' })
    glassChecks(ctx, g, t, 'default frost')
    coatChecks(t.tail, 90, 90, '8 Window 90/90 (one coat)')

    // #9 Reduce transparency and Increase contrast, live (KYBERN_A11Y_FILE).
    for (const [key, name] of [['reduceTransparency', 'reduce-transparency'], ['increaseContrast', 'increase-contrast']] as const) {
      writeFileSync(a11y, JSON.stringify({ [key]: true }))
      await until(async () => { await settle(300); const img = await ctx.shot('probe'); return !!solid.thread?.frame && deltaOnBoth(medianPixel(img, NEUTRAL.x, NEUTRAL.y), solid.thread.frame) <= 2 }, `${name} turns glass off`, 10_000).catch(() => {})
      await park(ctx.app); await settle(900)
      const img = await ctx.shot(`thread-${name}`, `thread-${name}`)
      const s: Shot = { name, img, file: img.file, boxes: await threadBoxes(ctx.app) }
      writeFileSync(`${img.file}.boxes.json`, JSON.stringify(s.boxes))
      const got: Samples = { ...regions(s), ...cardSamples(s) }
      const keys = key === 'reduceTransparency' ? Object.keys(got) : ['frame', 'panel', 'content', 'inboundAbove', 'inboundBand', 'header', 'body', 'diff']
      compareSamples(`9 ${name} equals Solid`, got, solid.thread, 2, keys)
      if (key === 'increaseContrast') record('9 increase-contrast borders', 'info', `composer ${both(got.composer)} vs Solid ${both(solid.thread?.composer)}, pill ${both(got.pill)} vs ${both(solid.thread?.pill)} (contrast border is allowed to differ)`)
    }
    writeFileSync(a11y, '{}')
    await until(async () => { await settle(300); const img = await ctx.shot('probe'); return blackWhiteDelta(medianPixel(img, NEUTRAL.x, NEUTRAL.y)) >= 3 }, 'glass returns', 10_000).catch(() => {})

    // #2 and #10: Settings › Appearance, Advanced closed and open.
    const shots = await appearance(ctx, 'settings-window', { advanced: 'both', named: 'settings-window', material: 'translucent' })
    for (const s of shots) {
      if (!s.boxes.track || s.boxes.track.y < 50) { record(`2 segmented (${s.name})`, 'info', 'scrolled out of view in this capture'); continue }
      const seg = segmented(s)
      const need = variant === 'dark' ? 14 : 10
      const deltas = ([['black', overBlack], ['white', overWhite]] as const).flatMap(([desk, on]) => ([['pad', seg.trackPad], ['gap', seg.trackGap]] as const).filter(([, p]) => p).map(([where, p]) => ({ desk, where, d: Math.abs(luminance(on(seg.thumb)) - luminance(on(p!))) })))
      const worst = Math.min(...deltas.map((d) => d.d))
      check(`2 segmented thumb vs track (${s.name})`, worst >= need, `ΔL ${deltas.map((d) => `${d.desk}/${d.where} ${d.d.toFixed(1)}`).join(', ')} (need ≥ ${need}); thumb ${both(seg.thumb)}, track ${both(seg.trackGap ?? seg.trackPad)}`)
    }
    writeFileSync(a11y, JSON.stringify({ reduceTransparency: true }))
    await settle(1500)
    await appearance(ctx, 'settings-reduce-transparency', { named: 'settings-reduce-transparency' })
    writeFileSync(a11y, '{}')
  })

  await session('frost-all', { KYBERN_WINDOW_MATERIAL: 'window', KYBERN_WINDOW_OPACITY: '90', KYBERN_GLASS_FROST: 'all' }, async (ctx) => {
    const t = await thread(ctx, 'thread', { menu: true, named: 'thread-window-frost-all' })
    glassChecks(ctx, G(), t, 'frost all')
  })
  await session('frost-none', { KYBERN_WINDOW_MATERIAL: 'window', KYBERN_WINDOW_OPACITY: '90', KYBERN_GLASS_FROST: 'none' }, async (ctx) => {
    const t = await thread(ctx, 'thread', { menu: true, named: 'thread-window-frost-none' })
    glassChecks(ctx, G(), t, 'frost none')
  })

  await session('sidebar', { KYBERN_WINDOW_MATERIAL: 'sidebar', KYBERN_WINDOW_OPACITY: '90' }, async (ctx) => {
    const t = await thread(ctx, 'thread', { menu: true, named: 'thread-sidebar' })
    const got = flat(t)
    const keys = ['content', 'inboundAbove', 'inboundBand', 'header', 'body', 'diff', 'composer', 'pill']
    compareSamples('7 Sidebar only content equals Solid (600 px up)', got.thread, solid.thread, 2, keys)
    compareSamples('7 Sidebar only content equals Solid (tail)', got.tail, solid.tail, 2, keys)
    record('7 Sidebar only frame/panel', 'info', `frame ${both(got.thread.frame)}, panel ${both(got.thread.panel)} (glass by design)`)
    await appearance(ctx, 'settings-sidebar', { advanced: 'both', named: 'settings-sidebar', material: 'translucent' })
  })

  for (const [s, c] of [[60, 90], [90, 60]] as const) {
    await session(`w${s}-${c}`, { KYBERN_WINDOW_MATERIAL: 'window', KYBERN_WINDOW_OPACITY: String(s), KYBERN_WINDOW_CONTENT_OPACITY: String(c) }, async (ctx) => {
      const t = await thread(ctx, 'thread', { named: `thread-window-${s}-${c}` })
      coatChecks(t.tail, s, c, `8 Window ${s}/${c}`)
    })
  }
} finally {
  release(); stopDisplay(); unDisplay()
  await fixture.close(); unFixture()
}

function rimEdge(img: Image, x0: number, y: number, interior: Rgba): Rgba {
  // Walk outward from inside the box: the first pixel that leaves the interior colour is the rim.
  for (let x = x0 + 5; x >= x0 - 4; x--) { const p = devicePixel(img, x, y); if (deltaOnBoth(p, interior) > 2) return p }
  return devicePixel(img, x0, y)
}

/** #8: the frame, the thread panel and the content card against the §5.3 stack for (s, c). */
function coatChecks(s: Shot, sidebar: number, content: number, id: string) {
  const m = materialFor(variant, 'window', sidebar, content)
  const frame = parseCss(m.frame)
  const want = { frame, panel: regionStack(frame, parseCss(m.sidebar)), content: regionStack(frame, parseCss(m.content)) }
  const got = regions(s)
  const rows = (Object.keys(want) as (keyof typeof want)[]).map((k) => ({ k, d: deltaOnBoth(got[k], want[k]), g: got[k], w: want[k] }))
  check(id, rows.every((r) => r.d <= 3), rows.map((r) => `${r.k} ${both(r.g)} vs §5.3 ${both(r.w)} (Δ ${r.d.toFixed(1)})`).join('; '))
}

/** #3–#6 on one whole-window run: inbound card, edited files, and the composer, pill and menu fills. */
function glassChecks(ctx: Ctx, g: GlassTokens, t: Awaited<ReturnType<typeof thread>>, arm: string) {
  const s = t.scrolled, b = s.boxes
  if (arm === 'default frost') {
    // #3: no band at the bottom of the clamped inbound message.
    if (bottomInView(s, b.clamped)) {
      const { band, above } = clampBandPoints(b.clamped)
      const ref = medianPixel(s.img, above[0]!.x, above[0]!.y)
      const rows = band.map((p) => ({ y: p.y - b.clamped!.y, px: medianPixel(s.img, p.x, p.y) })).map((r) => ({ ...r, d: deltaOnBoth(r.px, ref) }))
      check('3 inbound card: no band over the clamped text', rows.every((r) => r.d <= 3), `reference ${both(ref)} at y+${(above[0]!.y - b.clamped.y).toFixed(0)}; band ${rows.map((r) => `y+${r.y.toFixed(0)} Δ${r.d.toFixed(1)}`).join(', ')} (clamp ${b.clamped.height.toFixed(1)} pt, x = right − 24)`)
      record('3 inbound card fill', 'info', `card interior ${both(ref)}; black/white Δ ${blackWhiteDelta(ref).toFixed(1)} (raised tint over the coat is translucent)`)
      // Diagnosis: how a translucent fill stacks on the coat. Source-over (CSS, theme.ts stack) gives a + c(1 − a); an
      // additive alpha blend would give a + c.
      const coat = regions(s).frame, raised = parseCss(g.raised), over = stack(raised, coat)
      const additive = Math.min(255, raised[3] + coat[3])
      record('3 stacked alpha (raised card on the coat)', 'info', `measured a=${ref[3]}; source-over predicts a=${over[3].toFixed(1)}, an additive alpha blend a=${additive.toFixed(1)} (coat a=${coat[3]}, raised a=${raised[3]})`)
    } else record('3 inbound card', 'FAIL', 'the clamped inbound message is not in view 600 px up')

    // The renderer capture against the screen: estimate the blurred desktop behind the window from the coat in the margin
    // (screen = scene over desktop), then predict the screen at the card samples from the scene capture.
    if (s.os) {
      const sf = b.surface!, mx = sf.x + sf.width - Math.max(12, (sf.width - 736) / 4), my = sf.y + sf.height * 0.3
      const scene = medianPixel(s.img, mx, my), screen = medianPixel(s.os, mx, my), a = scene[3] / 255
      if (a < 0.99) {
        const desk = [0, 1, 2].map((i) => (screen[i]! - scene[i]! * a) / (1 - a)) as [number, number, number]
        const c = cardSamples(s), cs = Object.fromEntries(Object.entries(cardSamples({ ...s, img: s.os })).map(([k, v]) => [k, v]))
        const rows = (['inboundAbove', 'header', 'body'] as const).filter((k) => c[k] && cs[k]).map((k) => { const pred = [0, 1, 2].map((i) => c[k]![i]! * c[k]![3] / 255 + desk[i]! * (1 - c[k]![3] / 255)); return `${k} screen ${fmt(cs[k]!.slice(0, 3))} vs predicted ${fmt(pred)}` })
        record('scene capture matches the screen', 'info', `desktop behind the window ≈ ${fmt(desk)}; ${rows.join('; ')}`)
      }
    }

    // #4: edited files header = band over the body, both translucent.
    const c = cardSamples(s)
    if (c.header && c.body) {
      const want = stack(parseCss(g.band), c.body)
      const d = deltaOnBoth(c.header, want)
      check('4 edited files: header = band over body', d <= 3, `header ${both(c.header)}, body ${both(c.body)}, band over body ${both(want)} (Δ ${d.toFixed(1)}, ±3)`)
      check('4 edited files: header is translucent', blackWhiteDelta(c.header) >= 3, `black/white Δ ${blackWhiteDelta(c.header).toFixed(1)} (≥ 3)`)
      if (c.diff) record('4 edited files: diff body', 'info', `diff row ${both(c.diff)}; black/white Δ ${blackWhiteDelta(c.diff).toFixed(1)}`)
    } else record('4 edited files', 'FAIL', `header ${c.header ? 'sampled' : 'not in view'}, body ${c.body ? 'sampled' : 'not in view'}`)
  }

  // #5 / #6: composer (at the tail: only the coat below it), pill (600 px up) and menu (over the 600 px capture).
  const surfaces: { name: string; cls: FrostClass; img: Image; at: Box | null; inset: number; rim: string; beneath: () => Rgba | null; tint: keyof GlassTokens }[] = [
    { name: 'composer', cls: 'composer', img: t.tail.img, at: t.tail.boxes.composer, inset: 6, rim: g.frostRim, beneath: () => regions(t.tail).content, tint: 'frost' },
    { name: 'scroll pill', cls: 'pills', img: s.img, at: b.pill, inset: 5, rim: g.pillRim, tint: 'frost', beneath: () => {
      if (!b.pill) return null
      const l = medianPixel(s.img, b.pill.x - 6, b.pill.y + b.pill.height / 2), r = medianPixel(s.img, b.pill.x + b.pill.width + 6, b.pill.y + b.pill.height / 2)
      return deltaOnBoth(l, r) <= 3 ? l : null
    } },
    { name: 'model menu', cls: 'menus', img: t.menu?.img ?? s.img, at: t.menu?.boxes.panel ?? null, inset: 3, rim: g.frostRim, tint: 'frostMenu', beneath: () => {
      const p = t.menu?.boxes.panel
      return p ? medianPixel(s.img, leftInterior(p, 3).x, leftInterior(p, 3).y) : null
    } },
  ]
  for (const x of surfaces) {
    if (!x.at) { record(`5 ${x.name} (${arm})`, 'FAIL', 'not on screen'); continue }
    const p = leftInterior(x.at, x.inset)
    const interior = medianPixel(x.img, p.x, p.y)
    // The 1 pt rim: of the device pixels within 4 of the box's left edge, the one that stands out most from the interior
    // (layout bounds can sit a pixel off the painted border).
    const rimAt = leftRimDevice(x.at)
    const rims = [rimEdge(x.img, rimAt.xs[0]!, rimAt.y, interior)]
    const rimWant = stack(parseCss(x.rim), interior)
    const rimD = Math.min(...rims.map((r) => deltaOnBoth(r, rimWant)))
    const under = x.beneath()
    if (frostedNow(ctx.frost, x.cls)) {
      check(`5 ${x.name} is translucent (${arm}, frosted)`, blackWhiteDelta(interior) >= 3, `interior ${both(interior)}; black/white Δ ${blackWhiteDelta(interior).toFixed(1)} (≥ 3)`)
      check(`5 ${x.name} rim = frostRim over interior (${arm})`, rimD <= 4, `rim ${rims.map(both).join(' | ')} vs ${both(rimWant)} (best Δ ${rimD.toFixed(1)}, ±4; rim ${x.rim})`)
      if (under) record(`5 ${x.name} frost model (${arm})`, 'info', `interior vs ${x.tint} over the uniform backdrop ${both(stack(parseCss(g[x.tint] as string), under))}: Δ ${deltaOnBoth(interior, stack(parseCss(g[x.tint] as string), under)).toFixed(1)}`)
    } else {
      const want = under ? stack(parseCss(g.denseFloat), under) : null
      const d = want ? deltaOnBoth(interior, want) : NaN
      const id = arm === 'frost none' ? `6 ${x.name} = denseFloat (frost none)` : `5/6 ${x.name} not frosted (${arm}) = denseFloat`
      if (want) check(id, d <= 3, `interior ${both(interior)} vs denseFloat over beneath ${both(want)} (Δ ${d.toFixed(1)}, ±3)`)
      else record(id, 'FAIL', `interior ${both(interior)}; the backdrop beside it is not uniform, so denseFloat cannot be predicted`)
      record(`${arm === 'frost none' ? '6' : '5'} ${x.name} rim (${arm})`, rimD <= 4 ? 'ok' : 'FAIL', `rim ${rims.map(both).join(' | ')} vs ${both(rimWant)} (best Δ ${rimD.toFixed(1)}, ±4)`)
    }
  }
}

// ─── Report ──────────────────────────────────────────────────────────────────────────────────────────────────────────

record('10 Settings captures', 'info', `by eye against /Users/mymac/projects/ade/.kybern-artifacts/ade-grill/ade47r2-settings-${variant}.png: ${SHOTS}/r2-settings-{window,sidebar}-advanced-{open,closed}-${variant}.png`)
writeFileSync(path.join(OUT, `glass-${variant}.json`), JSON.stringify({ variant, baseline: BASELINE, patchedNative: PATCHED_NATIVE, results }, null, 2))
const failed = results.filter((r) => r.status === 'FAIL')
console.log(`\n${variant}: ${results.filter((r) => r.status === 'ok').length} ok, ${failed.length} failed, ${results.filter((r) => r.status === 'info').length} info. Captures: ${OUT}; named: ${SHOTS}`)
process.exit(failed.length ? 1 : 0)
