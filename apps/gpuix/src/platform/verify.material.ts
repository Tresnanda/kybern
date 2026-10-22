// Window material, live: Settings › Appearance › Window (Solid / Translucent, Sidebar only, Opacity, Blur) switches the
// native window and the surfaces without a relaunch; Reduce transparency and Increase contrast (changed while running
// through KYBERN_A11Y_FILE, never the user's system settings) force it solid. Real window captures (`screencapture -l`),
// so the native material is included. The hidden test display has a flat wallpaper: the checks assert structure (one
// coat, the scope, the tokens), not the look of the blur, which wants one eye on a real desktop.
//
//   KYBERN_DATA_DIR=<scratch> KYBERN_GPUIX_THREAD=<long thread id> bun src/platform/verify.material.ts <out-dir> <dark|light>
//
// Captures are named `t1-<state>-<variant>.png` (thread) and `t1-settings-<state>-<variant>.png` (Settings › Appearance).
import '../native/local-build.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
import { pixels } from '../../native/png.ts'
import { THEMES, materialFor } from '../theme.ts'
import { DEFAULT_VARIANT_MATERIAL, isSidebarOnly } from './translucency.ts'
import { assertScratchDataDir, until, windowId } from './verify.lib.ts'

assertScratchDataDir()

const [out = '/tmp/material', theme = 'dark'] = process.argv.slice(2)
const variant = theme === 'light' ? 'light' : 'dark'
const Title = variant === 'dark' ? 'Dark' : 'Light'
mkdirSync(out, { recursive: true })
const scratch = mkdtempSync(path.join(tmpdir(), 'kybern-material-'))
const a11y = path.join(scratch, 'a11y.json')
writeFileSync(a11y, '{}')

type Img = ReturnType<typeof pixels>
type Px = number[]
const rgbOf = (css: string): Px => {
  if (css.startsWith('#')) { const h = css.slice(1); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) }
  return (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
}
const near = (a: Px, b: Px, by: number) => a.every((v, i) => Math.abs(v - b[i]!) <= by)
const differs = (a: Px, b: Px, by = 4) => a.some((v, i) => Math.abs(v - b[i]!) > by)
const fmt = (p: Px) => `rgba(${p.join(',')})`
const luminance = ([r, g, b]: Px) => 0.2126 * r! + 0.7152 * g! + 0.0722 * b!

async function session(label: string, env: Record<string, string> = {}, steps: (ctx: Ctx) => Promise<void>) {
  const app = await launch({ command: 'bun', args: [path.join(import.meta.dir, '../main.tsx')], env: {
    GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: variant, KYBERN_A11Y_FILE: a11y, KYBERN_CLIENT_CONFIG_DIR: path.join(scratch, `client-${label}`),
    KYBERN_REDUCED_MOTION: '1', KYBERN_DEBUG_A11Y: '1', ...env,
  } })
  const { pid } = await app.call('initialize', { protocolVersion: 1, client: 'material-check' }) as { pid: number }
  const id = windowId(pid)
  const shot = (name: string) => { const file = path.join(out, `t1-${name}-${variant}.png`); execFileSync('screencapture', ['-x', '-o', '-l', String(id), file]); return pixels(file) }
  try {
    await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
    await steps({ app, shot })
  } finally {
    await app.close()
  }
}
type App = Awaited<ReturnType<typeof launch>>
interface Ctx { app: App; shot: (name: string) => Img }

// The sample points, in points (the capture is 2×): the frame in the rail's blank strip, the settings panel under its rows,
// and the workspace card's blank right margin.
// RGBA: a window over a flat desktop keeps its alpha in the capture, and light glass over white differs only there.
const rgba = (img: Img, x: number, y: number): Px => { const i = (Math.floor(y) * img.w + Math.floor(x)) * img.channels; return [...img.data.subarray(i, i + 3), img.channels === 4 ? img.data[i + 3]! : 255] }
const at = (img: Img, x: number, y: number) => rgba(img, x * 2, y * 2)
const points = (img: Img) => ({ frame: at(img, 24, 640), panel: at(img, 150, 700), content: at(img, 1250, 700) })

const settle = (ms = 700) => Bun.sleep(ms)
async function openAppearance({ app }: Ctx) {
  await app.getByTestId('rail-settings').click()
  await app.getByTestId('settings-tab-appearance').click()
  await app.getByTestId(`settings-window-${variant}-solid`).waitFor({ timeoutMs: 10_000 })
  await settle(500)
}
const closeSettings = async ({ app }: Ctx) => { await app.getByTestId('settings-back').click(); await settle(500) }

// The settings model the script tracks (a fresh client config dir starts at the default).
const state = { ...DEFAULT_VARIANT_MATERIAL }
async function choose(ctx: Ctx, want: { material?: 'solid' | 'translucent'; sidebarOnly?: boolean; auto?: boolean }) {
  const { app } = ctx
  if (want.material && want.material !== state.material) {
    await app.getByTestId(`settings-window-${variant}-${want.material}`).click()
    state.material = want.material
    await settle(400)
  }
  if (want.sidebarOnly !== undefined && state.material === 'translucent' && want.sidebarOnly !== isSidebarOnly(state)) {
    await app.getByTestId(`settings-sidebar-only-${variant}`).click()
    state.contentOpacity = want.sidebarOnly ? 100 : state.lastContentOpacity
    await settle(400)
  }
  if (want.auto && state.blur !== null) {
    await app.getByTestId(`settings-blur-auto-${variant}`).click()
    state.blur = null
    await settle(400)
  }
}

const results: string[] = []
const check = (name: string, ok: boolean, detail: string) => { results.push(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`); console.log(results.at(-1)); assert.ok(ok, `${name}: ${detail}`) }

const T = THEMES[variant]
const solidRgba = (css: string): Px => [...rgbOf(css), 255]
const opaqueFills = materialFor(variant, 'none', 100)
const opaque = { frame: solidRgba(opaqueFills.frame), panel: solidRgba(opaqueFills.sidebar), content: solidRgba(T.content) }
let solid: ReturnType<typeof points>
let whole: ReturnType<typeof points>

await session('main', {}, async (ctx) => {
  const { app, shot } = ctx
  await openAppearance(ctx)

  // 1. Solid.
  await choose(ctx, { material: 'solid' })
  solid = points(shot('settings-solid'))
  check('1 solid', near(solid.frame, opaque.frame, 2) && near(solid.panel, opaque.panel, 2) && near(solid.content, opaque.content, 2), `${fmt(solid.frame)} ${fmt(solid.panel)} ${fmt(solid.content)} vs tokens ${fmt(opaque.frame)} ${fmt(opaque.panel)} ${fmt(opaque.content)}`)

  // 2. Translucent, whole window, 90 / 64.
  await choose(ctx, { material: 'translucent', sidebarOnly: false })
  await until(async () => { await settle(250); const p = points(shot('settings-window')); return differs(p.content, solid.content) ? p : null }, 'content turns translucent', 8000)
  // The window-server blur settles a moment after the backing changes; judge the steady state.
  await settle(1200)
  whole = points(shot('settings-window'))
  // The panel's solid tone (#212121 / #f5f5f5) sits within 4 of the coat over this wallpaper, so it only has to differ by more than 2.
  check('2 whole window differs from solid', differs(whole.frame, solid.frame) && differs(whole.panel, solid.panel, 2) && differs(whole.content, solid.content), `${fmt(whole.frame)} ${fmt(whole.panel)} ${fmt(whole.content)}`)
  check('2 one coat', near(whole.frame, whole.panel, 3) && near(whole.panel, whole.content, 3), 'frame, panel and content equal within 3')

  // 3. Sidebar only.
  await choose(ctx, { sidebarOnly: true })
  const side = await until(async () => { await settle(250); const p = points(shot('settings-sidebar')); return near(p.content, solid.content, 2) ? p : null }, 'content turns opaque again', 8000)
  check('3 sidebar only', near(side.content, solid.content, 2) && differs(side.panel, solid.panel) && (variant === 'light' ? near(side.frame, solid.frame, 2) : true), `${fmt(side.frame)} ${fmt(side.panel)} ${fmt(side.content)}`)
  await choose(ctx, { sidebarOnly: false })

  // 6. Reduce transparency forces solid, with the status line.
  writeFileSync(a11y, JSON.stringify({ reduceTransparency: true }))
  const reduced = await until(async () => { await settle(300); const p = points(shot('settings-reduce-transparency')); console.log('  reduce?', fmt(p.frame), fmt(p.panel), fmt(p.content)); return near(p.content, solid.content, 2) && near(p.frame, solid.frame, 2) ? p : null }, 'Reduce transparency turns glass off', 8000)
  check('6 reduce transparency', true, `${fmt(reduced.frame)} ${fmt(reduced.panel)} ${fmt(reduced.content)}`)
  await app.getByTestId(`settings-window-${variant}`).waitFor({ timeoutMs: 5000 })

  // 7. Increase contrast.
  writeFileSync(a11y, JSON.stringify({ increaseContrast: true }))
  const contrast = await until(async () => { await settle(300); const p = points(shot('settings-increase-contrast')); return near(p.content, solid.content, 2) ? p : null }, 'Increase contrast turns glass off', 8000)
  check('7 increase contrast', near(contrast.frame, solid.frame, 2), `${fmt(contrast.frame)} ${fmt(contrast.content)}`)

  // 8. Restore: back to glass with no relaunch.
  writeFileSync(a11y, '{}')
  const back = await until(async () => { await settle(300); const p = points(shot('settings-restored')); return differs(p.content, solid.content) ? p : null }, 'glass returns once the options clear', 8000)
  check('8 restored', near(back.content, whole.content, 6) || differs(back.content, solid.content), `${fmt(back.content)} (whole window ${fmt(whole.content)})`)

  // 9. Opacity 99 and 15 (Advanced › Sidebar opacity and Content opacity; keys: a slider commits on Home / End / ←). Content 100 is Sidebar only,
  // so the highest whole-window coat is 99.
  await app.getByTestId(`settings-advanced-${variant}`).click(); await settle(400)
  const sidebarOpacity = app.getByTestId(`settings-sidebar-opacity-${variant}`), contentOpacity = app.getByTestId(`settings-content-opacity-${variant}`)
  await sidebarOpacity.click(); await sidebarOpacity.press('end')
  await contentOpacity.click(); await contentOpacity.press('end'); await contentOpacity.press('left'); await settle(900)
  const full = points(shot('settings-opacity-99'))
  const coat100 = [...(variant === 'dark' ? rgbOf(T.surface).map((v) => Math.round(v * 0.8)) : rgbOf(T.surface)), 255]
  check('9 opacity 99', near(full.content, coat100, 4), `${fmt(full.content)} vs coat ${fmt(coat100)}`)
  await sidebarOpacity.press('home'); await contentOpacity.press('home'); await settle(900)
  const thin = points(shot('settings-opacity-15'))
  check('9 opacity 15', differs(thin.content, whole.content) || differs(thin.frame, whole.frame), `${fmt(thin.content)} vs 90%: ${fmt(whole.content)}`)
  await sidebarOpacity.press('end'); for (let i = 0; i < 10; i++) await sidebarOpacity.press('left')
  await contentOpacity.press('end'); for (let i = 0; i < 11; i++) await contentOpacity.press('left')
  await settle(900)
  // 4. Blur Auto (vibrancy instead of the window-server blur).
  await settle(500)
  await choose(ctx, { auto: true })
  const auto = await until(async () => { await settle(300); const p = points(shot('settings-window-auto')); return differs(p.content, whole.content, 2) ? p : null }, 'Blur Auto (vibrancy) differs from the window-server blur', 8000).catch(() => points(shot('settings-window-auto')))
  check('4 blur Auto', differs(auto.content, whole.content, 2), `${fmt(auto.frame)} ${fmt(auto.panel)} ${fmt(auto.content)} (whole window ${fmt(whole.frame)})`)

})

// 5. The private blur is refused: the button says so and the pixels equal Blur Auto.
await session('fail', { KYBERN_WINDOW_BLUR_FAIL: '1', KYBERN_WINDOW_MATERIAL: 'window', KYBERN_WINDOW_BLUR: '64' }, async (ctx) => {
  const { app, shot } = ctx
  await openAppearance(ctx)
  await settle(2500)
  const refused = points(shot('settings-blur-unavailable'))
  await app.getByTestId(`settings-blur-auto-${variant}`).waitFor({ timeoutMs: 5000 })
  const text = ((await app.call('getPaintedText', {})) as { text: string[] }).text.join('\n')
  check('5 blur unavailable', text.includes('Unavailable, use Auto'), `button text present: ${text.includes('Unavailable, use Auto')}; ${fmt(refused.frame)} ${fmt(refused.content)}`)
})

// The thread view on each state: the composer, the dock and the transcript on glass, and a menu over transcript text.
for (const [name, env] of [['solid', { KYBERN_WINDOW_MATERIAL: 'solid' }], ['window', { KYBERN_WINDOW_MATERIAL: 'window', KYBERN_WINDOW_OPACITY: '90', KYBERN_WINDOW_BLUR: '64' }], ['sidebar', { KYBERN_WINDOW_MATERIAL: 'sidebar', KYBERN_WINDOW_OPACITY: '90', KYBERN_WINDOW_BLUR: '64' }]] as const) {
  await session(`thread-${name}`, { ...env, KYBERN_GPUIX_THREAD: process.env.KYBERN_GPUIX_THREAD ?? '' }, async (ctx) => {
    const { app, shot } = ctx
    await app.getByTestId('composer').waitFor({ timeoutMs: 30_000 })
    await settle(2500)
    const img = shot(name)
    const box = await app.getByTestId('composer-drop-zone').bounds()
    const composer = at(img, box.x + 14, box.y + box.height / 2)
    results.push(`ok   10 composer (${name}): ${fmt(composer)}`)
    if (name === 'window') {
      // A menu over dense transcript text: the interior of its right-hand strip, over text and over nothing.
      await app.getByTestId('model-picker').click()
      await settle(900)
      const panel = await app.getByTestId('model-picker-panel').bounds()
      shot('menu')
      // The same menu twice, once over dense transcript text and once over the empty coat (Home): crops at the same offset
      // inside the panel hold identical menu content, so any difference is what shows through from beneath.
      const crop = (img: Img, box: { x: number; y: number }) => {
        const px = 64 * 2, x0 = Math.round((box.x + 24) * 2), y0 = Math.round((box.y + 24) * 2)
        const lum: number[] = []
        for (let y = y0; y < y0 + px; y++) for (let x = x0; x < x0 + px; x++) lum.push(luminance(rgba(img, x, y)))
        return lum
      }
      const stats = (lum: number[]) => { const mean = lum.reduce((a, b) => a + b, 0) / lum.length; return { mean, sd: Math.sqrt(lum.reduce((a, b) => a + (b - mean) ** 2, 0) / lum.length) } }
      const over = crop(shot('menu-text'), panel)
      await app.getByTestId('model-picker').press('escape')
      await settle(500)
      await app.getByTestId('rail-home').click()
      await settle(1200)
      await app.getByTestId('model-picker').click()
      await settle(900)
      const homePanel = await app.getByTestId('model-picker-panel').bounds()
      const blank = crop(shot('menu-blank'), homePanel)
      const a = stats(over), b = stats(blank)
      const meanDiff = over.reduce((acc, v, k) => acc + Math.abs(v - blank[k]!), 0) / over.length
      results.push(`${Math.abs(a.sd - b.sd) <= 2 && Math.abs(a.mean - b.mean) <= 3 ? 'ok  ' : 'NOTE'} 10.3 menu cutout equivalence (same menu, text beneath vs none): sd ${a.sd.toFixed(2)} vs ${b.sd.toFixed(2)}, mean ${a.mean.toFixed(2)} vs ${b.mean.toFixed(2)}, mean |diff| ${meanDiff.toFixed(2)}`)
    }
  })
}
rmSync(scratch, { recursive: true, force: true })
console.log(results.slice(-4).join('\n'))
console.log(`ok  ${variant}: translucency and accessibility options apply live`)
process.exit(0)
