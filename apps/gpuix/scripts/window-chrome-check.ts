/**
 * WP3 window and input check: the real app's title bar on each OS, its window buttons and the shortcut key.
 *
 *   bun scripts/window-chrome-check.ts --kybernd <path> [--port 4391]
 *
 * Output (`KYBERN_VERIFY_OUTPUT`, else `native/build/window-chrome`): `window.png`, `titlebar.png` (the 46 px bar) and,
 * where the window can change state, `titlebar-hover-close.png` / `titlebar-maximized.png`; `window-chrome.json` lists
 * every measured state.
 *
 * - macOS: no app-drawn buttons; the leading controls start after the traffic lights (82 px).
 * - Windows: minimize, maximize and close flush with the top-right corner (46 px each, the bar's height), driven with real
 *   input (`native/win-input.ts`), because the buttons are caption hit-test areas the automation client's synthesized
 *   events never reach. Hovering close paints the Windows red; maximize, restore, a double click on the empty bar, a drag
 *   of the bar (the window moves), a click on a control inside the bar (it does not move the window), minimize, and
 *   close ending the process.
 * - Linux: `KYBERN_EXPECT_DECORATIONS=client` (a compositing window manager, `.github/workflows/gpuix-platforms.yml`)
 *   expects the GNOME-style buttons and drives them with `xdotool` (real X input): maximize, restore, the double click,
 *   the drag, a resize from the right edge, minimize and close. `server` (the default: bare Xvfb, nothing draws
 *   decorations and nothing manages windows) expects none drawn and only checks the layout and shortcuts.
 * - Everywhere: the shortcut key opens and closes the command palette (⌘K on macOS, Ctrl+K elsewhere), the other key
 *   does not (⌃K on macOS, Super+K elsewhere), and the sidebar toggles from the keyboard.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { capture, launch, near, outputDir, platform, pngPixels, settled, step, tolerance, writeCrop, type Fixture } from '../native/check-harness.ts'

const argv = process.argv.slice(2)
const arg = (name: string, fallback?: string) => {
  const at = argv.indexOf(`--${name}`)
  const value = at >= 0 ? argv[at + 1] : fallback
  if (value === undefined) throw new Error(`--${name} is required`)
  return value
}
const kybernd = path.resolve(arg('kybernd', process.env.KYBERND))
const port = Number(arg('port', '4391'))
const out = outputDir('window-chrome')
const expect = process.env.KYBERN_EXPECT_DECORATIONS ?? (platform === 'linux' ? 'server' : 'native')
const PRIMARY = platform === 'macos' ? 'cmd' : 'ctrl'
const OTHER = platform === 'macos' ? 'ctrl' : 'cmd'
const TITLEBAR = 46
const facts: Record<string, unknown> = { platform, expect }
/** Failures of the real-input steps (`soft`). */
const failures: string[] = []

// ---- a scratch daemon: the app needs one to come up ----
const data = path.join(process.env.KYBERN_DATA_DIR!, 'window-chrome')
rmSync(data, { recursive: true, force: true })
mkdirSync(data, { recursive: true })
// An empty library opens the first-run onboarding over the title bar; this check measures the app behind it.
writeFileSync(path.join(data, 'gpuix-ui.json'), JSON.stringify({ 'kybern.onboarding.completed': true }))
const daemon = spawn(kybernd, ['--data-dir', data, '--port', String(port)], { stdio: 'inherit' })
process.on('exit', () => daemon.exitCode === null && daemon.kill())
for (const deadline = Date.now() + 60_000; !existsSync(path.join(data, 'daemon.port'));) {
  if (daemon.exitCode !== null || Date.now() > deadline) throw new Error('The scratch daemon did not start')
  await Bun.sleep(50)
}

// Real input needs the window in front: on Windows and Linux the app opens focused (GPUIX_BACKGROUND=0), small enough
// for the runner's screen (the Windows runner's desktop is 1024x768).
const f: Fixture = await launch(path.join(import.meta.dir, '../src/main.tsx'), {
  KYBERN_APPEARANCE: 'dark',
  KYBERN_DATA_DIR: data,
  KYBERND: kybernd,
  KYBERN_CLIENT_CONFIG_DIR: path.join(data, 'client'),
  KYBERN_GPUIX_CREDENTIALS_DIR: path.join(data, 'credentials'),
  KYBERN_GPUIX_ENVIRONMENT: 'local',
  KYBERN_URL: '',
  KYBERN_TOKEN: '',
  KYBERN_WINDOW_SIZE: '960x680',
  ...(platform === 'macos' ? {} : { GPUIX_BACKGROUND: '0' }),
})
const a = f.app
const count = (id: string) => a.getByTestId(id).count()
const bounds = (id: string) => a.getByTestId(id).bounds()
let exited = false

try {
  await a.getByTestId('app-ready').waitFor({ timeoutMs: 90_000 })
  await a.getByTestId('sidebar-toggle').waitFor({ timeoutMs: 30_000 })
  await Bun.sleep(1500)
  const root = await bounds('app-ready')
  const drawn = (await count('window-controls')) > 0

  await step('title bar: window buttons for this platform', async () => {
    const toggle = await bounds('sidebar-toggle')
    facts.sidebarToggleX = toggle.x
    if (platform === 'macos') {
      assert.equal(drawn, false, 'macOS draws no window buttons of its own (traffic lights)')
      assert.ok(Math.abs(toggle.x - 82) <= 1, `the leading controls start after the traffic lights, at ${toggle.x}`)
      return
    }
    if (platform === 'linux' && expect === 'server') {
      assert.equal(drawn, false, 'server-side decorations: the window manager (or nothing) draws the buttons')
      assert.ok(Math.abs(toggle.x - 12) <= 1, `no traffic-light gap off macOS, toggle at ${toggle.x}`)
      return
    }
    assert.ok(drawn, `${platform}: the app draws the window buttons`)
    const [min, max, close] = await Promise.all(['window-minimize', 'window-maximize', 'window-close'].map(bounds))
    facts.buttons = { min, max, close }
    assert.ok(min!.x < max!.x && max!.x < close!.x, 'minimize, maximize, close in that order')
    if (platform === 'windows') {
      for (const b of [min!, max!, close!]) assert.ok(Math.abs(b.width - 46) <= 1 && Math.abs(b.height - TITLEBAR) <= 1, `a Windows caption button is 46x46, got ${b.width}x${b.height}`)
      assert.ok(Math.abs(close!.x + close!.width - (root.x + root.width)) <= 1 && close!.y <= root.y + 1, 'close is flush with the top-right corner')
    } else {
      for (const b of [min!, max!, close!]) assert.ok(Math.abs(b.width - 24) <= 1 && Math.abs(b.height - 24) <= 1, `a GNOME button is 24x24, got ${b.width}x${b.height}`)
      assert.ok(root.x + root.width - (close!.x + close!.width) <= 16, 'the buttons sit at the trailing edge (default layout)')
    }
    assert.ok(Math.abs(toggle.x - 12) <= 1, `the leading controls start at the window's edge, at ${toggle.x}`)
    const dock = await bounds('dock-toggle')
    assert.ok(dock.x + dock.width <= min!.x - 8, 'the panel toggles end before the window buttons')
  })

  const shot = async (name: string) => {
    const file = await capture(f, path.join(out, `${name}.png`))
    const png = pngPixels(file), scale = png.width / root.width
    writeCrop(png, scale, { x: 0, y: 0, width: root.width, height: TITLEBAR }, path.join(out, name === 'window' ? 'titlebar.png' : `titlebar-${name}.png`))
    return { png, scale }
  }
  await step('title bar: captured', () => shot('window'))

  await step(`shortcuts: ${PRIMARY}+K opens the palette, ${OTHER}+K does not`, async () => {
    const body = a.getByTestId('app-ready')
    await body.press(`${OTHER}-k`)
    await Bun.sleep(400)
    assert.equal(await count('palette'), 0, `${OTHER}+K is not the shortcut key here`)
    await body.press(`${PRIMARY}-k`)
    assert.equal(await settled(() => count('palette'), n => n === 1), 1, `${PRIMARY}+K opens the palette`)
    await body.press('escape')
    assert.equal(await settled(() => count('palette'), n => n === 0), 0, 'Escape closes it')
    const open = await count('sidebar-viewport')
    await body.press(`${PRIMARY}-b`)
    assert.notEqual(await settled(() => count('sidebar-viewport'), n => n !== open), open, `${PRIMARY}+B toggles the thread sidebar`)
    await body.press(`${PRIMARY}-b`)
    await settled(() => count('sidebar-viewport'), n => n === open)
  })

  if (platform === 'windows' && drawn) await windows()
  if (platform === 'linux' && expect === 'client' && drawn) await linux()
} catch (error) {
  console.error(f.diagnostics())
  throw error
} finally {
  writeFileSync(path.join(out, 'window-chrome.json'), JSON.stringify(facts, null, 2))
  if (!exited) await f.close().catch(() => {})
  if (daemon.exitCode === null) daemon.kill()
}
process.exit(0)

/** An empty point of the title bar: the drag region right of the title, left of the toggles. */
async function emptyBar(): Promise<[number, number]> {
  const root = await bounds('app-ready'), dock = await bounds('dock-toggle')
  return [Math.round(root.x + Math.max(420, (dock.x - 60) * 0.7)), 14]
}

/** A real-input step that records its failure and lets the rest run, so one run shows every result; `finish` throws. */
async function soft(label: string, run: () => Promise<void>) {
  try { await step(label, run) } catch (error) { failures.push(`${label}: ${error instanceof Error ? error.message.split('\n')[0] : error}`) }
}
function finish() {
  facts.failures = failures
  if (failures.length) throw new Error(`${failures.length} window step(s) failed:\n${failures.join('\n')}`)
}

async function windows() {
  const w = await import('../native/win-input.ts')
  const hwnd = await settled(async () => w.findWindow(f.pid), id => id !== 0, 10_000)
  assert.ok(hwnd, 'the GPUI window of the app process')
  const win = w.windowOf(hwnd)
  const state = () => w.windowState(hwnd)
  const centre = async (id: string): Promise<[number, number]> => { const b = await bounds(id); return [b.x + b.width / 2, b.y + b.height / 2] }
  facts.initial = state()

  await soft('Windows: hovering close paints the Windows red', async () => {
    await w.move(win, ...(await centre('window-close')))
    await Bun.sleep(400)
    const shot = w.capture(win, path.join(out, 'titlebar-hover-close.png'))
    const [x, y] = await centre('window-close')
    const pixel = shot.at(x - 12, y - 12)
    facts.closeHover = pixel
    assert.ok(near(pixel, [196, 43, 28], tolerance + 6), `close hover fill is #C42B1C, got ${pixel}`)
    await w.move(win, 300, 300)
  })
  await soft('Windows: the hit test answers the caption, its buttons and the controls in it, at the point it is sent', async () => {
    const probes: Record<string, string> = {}
    // The cursor stays in the content: GPUI must hit-test the message's point, as for a touch or pen tap.
    await w.move(win, 300, 300); await Bun.sleep(150)
    for (const [name, at] of [['minimize', await centre('window-minimize')], ['maximize', await centre('window-maximize')], ['close', await centre('window-close')], ['empty bar', await emptyBar()], ['sidebar toggle', await centre('sidebar-toggle')]] as const) {
      // A hit test that reaches GPUI mid-update answers from its last one, as for the previous point; Windows asks
      // again on the press, so the probe does too.
      const want = name === 'empty bar' ? 'caption' : name === 'sidebar toggle' ? 'client' : name
      for (let attempt = 0; attempt < 4 && (probes[name] = w.hitTest(win, at[0], at[1])) !== want; attempt++) await Bun.sleep(150)
    }
    facts.hitTest = probes
    assert.deepEqual(probes, { minimize: 'minimize', maximize: 'maximize', close: 'close', 'empty bar': 'caption', 'sidebar toggle': 'client' })
  })
  const controlClick = async () => {
    // Closing the thread panel swaps back/forward for New thread in the bar at once (the panel itself slides out).
    const before = state(), closed = await count('titlebar-new-thread')
    await w.click(w.windowOf(hwnd), ...(await centre('sidebar-toggle')))
    assert.notEqual(await settled(() => count('titlebar-new-thread'), n => n !== closed, 6000), closed, 'the sidebar toggle toggled the thread panel')
    const after = state()
    assert.ok(after.x === before.x && after.y === before.y && !after.maximized, 'and the window did not move or maximize')
    await Bun.sleep(600)
    await w.click(w.windowOf(hwnd), ...(await centre('sidebar-toggle')))
    await settled(() => count('titlebar-new-thread'), n => n === closed, 6000)
  }
  await soft('Windows: a control inside the title bar keeps its click', controlClick)
  await soft('Windows: maximize and restore through the caption button', async () => {
    await w.click(win, ...(await centre('window-maximize')))
    assert.ok((await settled(async () => state(), s => s.maximized)).maximized, 'IsZoomed after clicking maximize')
    await Bun.sleep(600)
    facts.maximized = state()
    w.capture(win, path.join(out, 'titlebar-maximized.png'))
    await w.click(w.windowOf(hwnd), ...(await centre('window-maximize')))
    assert.ok(!(await settled(async () => state(), s => !s.maximized)).maximized, 'restored after clicking it again')
  })
  await soft('Windows: a double click on the empty title bar maximizes and restores', async () => {
    await Bun.sleep(400)
    await w.click(w.windowOf(hwnd), ...(await emptyBar()), 2)
    assert.ok((await settled(async () => state(), s => s.maximized)).maximized, 'IsZoomed after the double click')
    await Bun.sleep(600)
    await w.click(w.windowOf(hwnd), ...(await emptyBar()), 2)
    assert.ok(!(await settled(async () => state(), s => !s.maximized)).maximized, 'restored by the second double click')
  })
  await soft('Windows: dragging the title bar moves the window', async () => {
    await Bun.sleep(600)
    const before = state(), from = await emptyBar()
    await w.dragWindow(w.windowOf(hwnd), from, [from[0] - 120, from[1] + 70])
    const after = await settled(async () => state(), s => s.x !== before.x || s.y !== before.y)
    facts.drag = { before, after }
    assert.ok(Math.abs(after.x - before.x + 120 * win.scale) <= 12 && Math.abs(after.y - before.y - 70 * win.scale) <= 12, `moved by (${after.x - before.x}, ${after.y - before.y}), wanted about (-120, 70) points`)
    // And back: the runner's desktop is barely wider than the window, so the drag left its leading edge off-screen,
    // where a real click cannot reach the controls.
    const back = await emptyBar()
    await w.dragWindow(w.windowOf(hwnd), back, [back[0] + 120, back[1] - 70])
    const home = await settled(async () => state(), s => Math.abs(s.x - before.x) <= 12 && Math.abs(s.y - before.y) <= 12)
    assert.ok(Math.abs(home.x - before.x) <= 12 && Math.abs(home.y - before.y) <= 12, `dragged back to (${home.x}, ${home.y}), started at (${before.x}, ${before.y})`)
  })
  // Windows runs a drag of the caption in its own modal loop: the app must take the next click normally.
  await soft('Windows: a control inside the title bar keeps its click after a window drag', async () => {
    const at = await centre('sidebar-toggle')
    await w.move(win, at[0], at[1]); await Bun.sleep(200)
    facts.afterDrag = { hitTest: w.hitTest(w.windowOf(hwnd), at[0], at[1]) }
    await controlClick()
  })
  await soft('Windows: the real Ctrl key opens the palette', async () => {
    await w.key(0x4b, [0x11])
    assert.equal(await settled(() => count('palette'), n => n === 1), 1, 'Ctrl+K from the keyboard')
    await w.key(0x1b)
    await settled(() => count('palette'), n => n === 0)
  })
  await soft('Windows: minimize through the caption button', async () => {
    await w.click(w.windowOf(hwnd), ...(await centre('window-minimize')))
    assert.ok((await settled(async () => state(), s => s.minimized)).minimized, 'IsIconic after clicking minimize')
    w.restoreWindow(hwnd)
    assert.ok(!(await settled(async () => state(), s => !s.minimized)).minimized, 'restored')
    await Bun.sleep(800)
  })
  await soft('Windows: close through the caption button ends the app', async () => {
    await w.click(w.windowOf(hwnd), ...(await centre('window-close')))
    const gone = await settled(async () => state().exists, exists => !exists, 15_000)
    assert.equal(gone, false, 'the window is destroyed (no close guard question with nothing running)')
    exited = true
  })
  finish()
}

async function linux() {
  const x = (...args: string[]) => execFileSync('xdotool', args, { encoding: 'utf8', timeout: 15_000 }).trim()
  const ids = x('search', '--sync', '--onlyvisible', '--pid', String(f.pid)).split('\n').filter(Boolean)
  const geometry = (id: string) => Object.fromEntries(x('getwindowgeometry', '--shell', id).split('\n').map(l => l.split('=')).map(([k, v]) => [k, Number(v)])) as { X: number; Y: number; WIDTH: number; HEIGHT: number }
  const id = ids.sort((p, q) => geometry(q).WIDTH * geometry(q).HEIGHT - geometry(p).WIDTH * geometry(p).HEIGHT)[0]!
  const props = () => { try { return execFileSync('xprop', ['-id', id, '_NET_WM_STATE', 'WM_STATE'], { encoding: 'utf8', timeout: 10_000 }) } catch { return '' } }
  const state = () => {
    const p = props(), g = geometry(id)
    return { maximized: p.includes('_NET_WM_STATE_MAXIMIZED_VERT') && p.includes('_NET_WM_STATE_MAXIMIZED_HORZ'), minimized: p.includes('_NET_WM_STATE_HIDDEN') || /window state: Iconic/.test(p), x: g.X, y: g.Y, width: g.WIDTH, height: g.HEIGHT }
  }
  // Window points to screen pixels (the X window is the GPUI window; client-side decorations put the bar at its top).
  const scale = () => geometry(id).WIDTH / (readRoot.width || 1)
  let readRoot = await bounds('app-ready')
  const at = (px: number, py: number) => { const g = geometry(id), s = scale(); return [String(Math.round(g.X + px * s)), String(Math.round(g.Y + py * s))] as const }
  const click = async (px: number, py: number, repeat = 1) => { x('mousemove', '--sync', ...at(px, py)); await Bun.sleep(120); x('click', '--repeat', String(repeat), '--delay', '80', '1'); await Bun.sleep(300) }
  const centre = async (testId: string): Promise<[number, number]> => { const b = await bounds(testId); return [b.x + b.width / 2, b.y + b.height / 2] }
  const drag = async (from: readonly [number, number], dx: number, dy: number) => {
    const [sx, sy] = at(...from).map(Number) as [number, number]
    x('mousemove', '--sync', String(sx), String(sy)); await Bun.sleep(120)
    x('mousedown', '1'); await Bun.sleep(120)
    for (let n = 1; n <= 12; n++) { x('mousemove', String(Math.round(sx + (dx * n) / 12)), String(Math.round(sy + (dy * n) / 12))); await Bun.sleep(40) }
    await Bun.sleep(120); x('mouseup', '1'); await Bun.sleep(400)
  }
  facts.initial = state()

  await soft('Linux: maximize and restore through the drawn button', async () => {
    await click(...(await centre('window-maximize')))
    assert.ok((await settled(async () => state(), s => s.maximized)).maximized, '_NET_WM_STATE maximized after clicking maximize')
    await Bun.sleep(600)
    readRoot = await bounds('app-ready')
    facts.maximized = state()
    const file = await capture(f, path.join(out, 'maximized.png'))
    const png = pngPixels(file)
    writeCrop(png, png.width / readRoot.width, { x: 0, y: 0, width: readRoot.width, height: TITLEBAR }, path.join(out, 'titlebar-maximized.png'))
    await click(...(await centre('window-maximize')))
    assert.ok(!(await settled(async () => state(), s => !s.maximized)).maximized, 'restored after clicking it again')
    await Bun.sleep(600)
    readRoot = await bounds('app-ready')
  })
  await soft('Linux: a double click on the empty title bar maximizes', async () => {
    await click(...(await emptyBar()), 2)
    assert.ok((await settled(async () => state(), s => s.maximized)).maximized, 'maximized after the double click')
    await Bun.sleep(600)
    readRoot = await bounds('app-ready')
    await click(...(await emptyBar()), 2)
    assert.ok(!(await settled(async () => state(), s => !s.maximized)).maximized, 'restored by the second one')
    await Bun.sleep(600)
    readRoot = await bounds('app-ready')
  })
  await soft('Linux: dragging the title bar moves the window', async () => {
    const before = state()
    await drag(await emptyBar(), -120, 70)
    const after = await settled(async () => state(), s => s.x !== before.x || s.y !== before.y)
    facts.drag = { before, after }
    // The compositor takes the move over at the first motion after the press, from the pointer's position then, so the
    // window follows most of the drag rather than all of it.
    const dx = after.x - before.x, dy = after.y - before.y
    assert.ok(dx <= -50 && dx >= -136 && dy >= 30 && dy <= 86, `moved by (${dx}, ${dy}), wanted most of (-120, 70)`)
  })
  await soft('Linux: the right edge resizes the window', async () => {
    readRoot = await bounds('app-ready')
    const before = state()
    await drag([readRoot.width - 2, readRoot.height / 2], 90, 0)
    const after = await settled(async () => state(), s => s.width !== before.width)
    facts.resize = { before, after }
    assert.ok(after.width - before.width >= 60, `the window grew by ${after.width - before.width} px from the right edge`)
    readRoot = await bounds('app-ready')
  })
  await soft('Linux: minimize through the drawn button', async () => {
    await click(...(await centre('window-minimize')))
    assert.ok((await settled(async () => state(), s => s.minimized)).minimized, 'iconic after clicking minimize')
    x('windowactivate', '--sync', id)
    assert.ok(!(await settled(async () => state(), s => !s.minimized)).minimized, 'restored')
    await Bun.sleep(800)
  })
  await soft('Linux: close through the drawn button ends the app', async () => {
    await click(...(await centre('window-close')))
    const gone = await settled(async () => { try { x('getwindowname', id); return false } catch { return true } }, done => done, 15_000)
    assert.ok(gone, 'the window is gone')
    exited = true
  })
  finish()
}

