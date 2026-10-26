// WP10 on Windows: the embedded web view in a real GPUIX window (`webview-win-lab.tsx`), driven with OS input and
// checked on captures of the composed window. Runs on windows-2022 in CI (Direct3D 11 on WARP, 100 % scale).
//
//   bun native/webview-win-check.ts [--out <dir>]
//
// Proves: stacking above GPUI, the rounded clip, transparency, a GPUI menu cut out of the page, a modal's dim, the
// message bridge both ways, clicks, double click, wheel, typing, Ctrl shortcuts, Escape and outside presses giving the
// keyboard back, `kybern.answer.draft` from the daemon's bootstrap, `present`/`probe`, `snapshot` (alpha kept),
// `snapshotRect`, `frame`, hide and destroy; a GPUI drag across the page reaching GPUI only; and a hostile page that
// cannot forge picker messages (the `KybernPreview` isolated world). Writes PNGs and `webview-win.json` to the output
// folder.
// Not provable here: real GPUs, DPI other than 100 %, IME, touch and pen.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchFixture } from '../src/requests/harness.ts'
import { capture, click, clickWith, drag, key, move, wheel, windowOf } from './win-input.ts'
import { pixels } from './png.ts'

if (process.platform !== 'win32') { console.log('webview-win-check: Windows only'); process.exit(0) }
const flag = (name: string) => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined }
const out = path.resolve(flag('--out') ?? 'webview-win-out')
mkdirSync(out, { recursive: true })
const scratch = mkdtempSync(path.join(tmpdir(), 'kybern-webview-win-'))
const results: { step: string; ok: boolean; detail?: unknown }[] = []
const record = (step: string, ok: boolean, detail?: unknown) => { results.push({ step, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${step}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`) }
/** Reported, never failing: behavior this runner cannot settle. */
const notes: { step: string; ok: boolean; detail?: unknown }[] = []
const note = (step: string, ok: boolean, detail?: unknown) => { notes.push({ step, ok, detail }); console.log(`NOTE ${ok ? 'yes' : 'no'} ${step}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`) }
const near = (got: number[], want: number[], tolerance = 40) => got.every((v, i) => Math.abs(v - want[i]!) <= tolerance)
const BACKGROUND = [36, 36, 36], BAND = [0, 120, 255]
/** Window points of the slot (left 20, top 100, 560 × 360, radius 28) and of the page's parts. */
const page = (x: number, y: number) => [20 + x, 100 + y] as const

const fixture = await launchFixture(path.join(import.meta.dir, 'webview-win-lab.tsx'), { KYBERN_DATA_DIR: scratch, KYBERN_URL: '', KYBERN_GPUIX_WEBVIEW2_DATA: path.join(scratch, 'WebView2'), KYBERN_GPUIX_WEBVIEW_TRACE: '1' })
const a = fixture.app
let failed = false
try {
  await a.getByTestId('app-ready').waitFor()
  const root = (await a.getByTestId('app-ready').element()).id
  const act = async (k: string, wait = 300) => { await a.call('keyDown', { elementId: root, key: k }); await Bun.sleep(wait) }
  const inspect = async () => { await act('i', 150); return JSON.parse(await a.getByTestId('result').textContent()) as { log: any[]; appKeys: string[]; mouse: { down: number; up: number; move: number } } }
  const result = async () => JSON.parse(await a.getByTestId('result').textContent())
  const until = async (what: string, test: (log: any[]) => boolean, ms = 30000) => {
    const end = Date.now() + ms
    for (;;) {
      const { log } = await inspect()
      if (test(log)) return log
      if (Date.now() > end) throw new Error(`${what} did not happen: ${JSON.stringify(log.filter(e => e.type !== 'trace')).slice(-3000)}\ntrace: ${JSON.stringify(log.filter(e => e.type === 'trace').map(e => e.message)).slice(-6000)}`)
      await Bun.sleep(300)
    }
  }
  const messages = (log: any[], kind: string) => log.filter(e => e.type === 'message' && e.data?.kind === kind)

  const started = Date.now()
  let log = await until('the page to load and report through the bridge', log => log.some(e => e.type === 'loaded') && messages(log, 'lab').some(e => e.data.ready))
  const created = log.find(e => e.type === 'created')
  record('create → loaded → page message through the wrapper', true, { ms: Date.now() - started, failed: log.filter(e => e.type === 'failed') })
  const win = windowOf(created.windowNumber)
  await Bun.sleep(800)

  await act('n')
  log = await until('the host → page → host round trip', log => messages(log, 'pong').length > 0)
  record('message bridge round trip (webHost.send → page → message)', messages(log, 'pong')[0].data.got === 42)

  let shot = capture(win, path.join(out, '01-placed.png'))
  capture(win, path.join(out, '01-placed-screen.png'), 'screen')
  record('page above GPUI (band)', near(shot.at(...page(300, 60)), BAND), shot.at(...page(300, 60)))
  record('rounded clip cuts the page corner', near(shot.at(...page(3, 3)), BACKGROUND), shot.at(...page(3, 3)))
  record('transparent page shows GPUI', near(shot.at(...page(400, 300)), BACKGROUND), shot.at(...page(400, 300)))

  await act('p', 700)
  shot = capture(win, path.join(out, '02-menu.png'))
  const underMenu = shot.at(200, 190)
  record('GPUI menu cut out of the page (occlusion)', !near(underMenu, BAND, 60) && near(shot.at(...page(450, 60)), BAND), { underMenu, beside: shot.at(...page(450, 60)) })
  await click(win, 200, 190)
  log = (await inspect()).log
  record('a press on the menu does not reach the page', !messages(log, 'lab').some(e => e.data.count))
  await act('p', 500)

  await act('d', 400)
  shot = capture(win, path.join(out, '03-dim.png'))
  const dimmed = shot.at(...page(300, 60))
  record('modal occlusion dims the page', near(dimmed, [0, 60, 128], 30), dimmed)
  await act('d', 400)

  const pressesBefore = log.filter(e => e.type === 'outsidePress').length
  record('the press on the menu (cut out of the page) counts as outside the visual', pressesBefore === 1, log.filter(e => e.type === 'outsidePress'))
  await click(win, ...page(80, 158))
  log = await until('the Count click', log => messages(log, 'lab').some(e => e.data.count === 1), 8000)
  record('click forwarded to the page', true)
  record('no outsidePress for a press inside the visual', log.filter(e => e.type === 'outsidePress').length === pressesBefore)

  await click(win, ...page(30, 203))
  await key(0x32)
  log = await until('typing into the page field', log => messages(log, 'lab').some(e => e.data.input === '2'), 8000)
  record('keyboard reaches the focused page', true)
  // `appKeys` also lists the automation's own `i` (inspect); only the typed digits count.
  await key(0x33)
  const typed = await inspect()
  record('GPUI gets no keys while the page has the keyboard', !typed.appKeys.includes('2') && !typed.appKeys.includes('3') && messages(typed.log, 'lab').some(e => e.data.input === '23'), typed.appKeys)

  await key(0x4c, [0x11])
  log = await until('Ctrl+L as a shortcut event', log => log.some(e => e.type === 'shortcut' && e.key === 'l'), 5000)
  record('Ctrl shortcut re-emitted while the page has focus', log.find(e => e.type === 'shortcut').modifiers.ctrl === true)

  await key(0x1b)
  await Bun.sleep(300)
  await key(0x34)
  const after = await inspect()
  record('unhandled Escape gives the keyboard back to GPUI', after.appKeys.includes('4') && !messages(after.log, 'lab').some(e => String(e.data.input ?? '').includes('4')), after.appKeys.slice(-3))

  await click(win, ...page(330, 205), 2)
  log = await until('a double click on the word', log => messages(log, 'lab').some(e => e.data.dblclick), 5000)
  record('double click (synthesized from two presses)', messages(log, 'lab').find(e => e.data.dblclick).data.dblclick.includes('doubleword'))

  await wheel(win, ...page(100, 280), -240)
  log = await until('the wheel over the scroller', log => messages(log, 'lab').some(e => e.data.scrolled > 0), 5000)
  record('wheel forwarded to the page', true)

  await click(win, ...page(270, 158))
  log = await until('kybern.answer.draft from the page', log => messages(log, 'kybern-visual-draft').length > 0, 8000)
  const draft = messages(log, 'kybern-visual-draft')[0].data
  record('visual goes live and drafts an answer (daemon bootstrap.js)', draft.value?.choice === 'B' && draft.label === 'Option B', draft)
  shot = capture(win, path.join(out, '04-live.png'))

  const pressed = log.filter(e => e.type === 'outsidePress').length
  await click(win, 700, 560)
  log = await until('outsidePress', log => log.filter(e => e.type === 'outsidePress').length > pressed, 5000)
  const outside = log.filter(e => e.type === 'outsidePress').at(-1)
  record('press outside the visual → outsidePress in window points', Math.abs(outside.x - 700) < 2 && Math.abs(outside.y - 560) < 2, outside)
  await move(win, 700, 40)

  // A GPUI drag across the page: the press is GPUI's until the release, so the page gets no down, move or up (not even
  // the up over it) and GPUI keeps getting moves over the page and the release.
  const stats = async () => {
    const count = messages((await inspect()).log, 'stats').length
    await act('m', 200)
    return messages(await until('the page mouse stats', log => messages(log, 'stats').length > count, 5000), 'stats').at(-1).data
  }
  const pageBefore = await stats(), gpuiBefore = (await inspect()).mouse
  let pageHeld: any = null
  await drag(win, [[700, 300], [300, 300], [10, 300], [300, 380]], 8, async () => { pageHeld = await stats() })
  const gpuiAfter = (await inspect()).mouse, pageAfter = await stats()
  const same = (a: any, b: any) => a.down === b.down && a.up === b.up && a.move === b.move
  record('a GPUI drag across the page reaches no page (no down, move or up)', same(pageHeld, pageBefore) && pageAfter.down === pageBefore.down && pageAfter.up === pageBefore.up && pageAfter.move - pageBefore.move <= 2, { pageBefore, pageHeld, pageAfter })
  record('GPUI keeps its drag over the page (moves and the release)', gpuiAfter.down === gpuiBefore.down + 1 && gpuiAfter.up === gpuiBefore.up + 1 && gpuiAfter.move - gpuiBefore.move >= 12, { gpuiBefore, gpuiAfter })
  await move(win, 700, 40)

  await act('e', 150)
  await act('g', 100)
  log = (await inspect()).log
  const midway = log.filter(e => e.type === 'probe').at(-1)
  capture(win, path.join(out, '05-present-midway.png'))
  await Bun.sleep(900)
  await act('g', 150)
  log = (await inspect()).log
  const rest = log.filter(e => e.type === 'probe').at(-1)
  record('present runs on the compositor and settles (probe)', midway?.data.animating === true && rest?.data.animating === false && rest.data.opacity === 1, { midway: midway?.data, rest: rest?.data })

  await act('s', 1500)
  const snap = await result()
  let alpha: unknown = null
  if (snap.ok && existsSync(snap.path)) {
    const image = pixels(snap.path)
    const at = (x: number, y: number) => [...image.data.subarray((y * image.w + x) * image.channels, (y * image.w + x) * image.channels + image.channels)]
    alpha = { channels: image.channels, band: at(300, 60), transparent: at(400, 300), size: [image.w, image.h] }
    writeFileSync(path.join(out, '06-snapshot.png'), readFileSync(snap.path))
  }
  record('snapshot writes a PNG with the page and its transparency', snap.ok === true && (alpha as any)?.channels === 4 && near((alpha as any).band.slice(0, 3), BAND) && (alpha as any).transparent[3] === 0, { snap, alpha })

  await act('r', 1500)
  const rect = await result()
  if (rect.rect?.path && existsSync(rect.rect.path)) writeFileSync(path.join(out, '07-snapshot-rect.png'), readFileSync(rect.rect.path))
  record('snapshotRect of a CSS rect', !!rect.rect && rect.rect.width === 200 && existsSync(rect.rect.path), rect)

  await act('f', 1200)
  const frame = await result()
  record('frame runs a script in the page frame', frame.frame?.href?.startsWith('http://127.0.0.1:') && frame.frame.band === 'rgb(0, 120, 255)', frame)

  await act('h', 800)
  log = (await inspect()).log
  shot = capture(win, path.join(out, '08-hidden.png'))
  record('hide: visibility false reaches the page and the page is gone', log.some(e => e.type === 'visibility' && e.visible === false) && messages(log, 'host-state').some(e => e.data.visible === false) && near(shot.at(...page(300, 60)), BACKGROUND), shot.at(...page(300, 60)))
  await act('h', 800)
  log = await until('visible again', log => log.filter(e => e.type === 'visibility').at(-1)?.visible === true, 5000)
  record('show again keeps the same document (no reload)', log.filter(e => e.type === 'loaded').length === 1)

  // A page cannot forge picker messages: the picker and Kybern's frame scripts run in the `KybernPreview` isolated world
  // through the DevTools protocol, and the page's own world has no handler, binding or bridge (`/forge` in the lab). The
  // hub (`src/pick/hub.ts`) and the composer hear only `frameMessage` events, so none may arrive except the real pick.
  const mark = log.length
  const forged = (log: any[]) => log.slice(mark).filter(e => e.type === 'frameMessage')
  const navigations = (log: any[]) => log.slice(mark).filter(e => e.type === 'navigation')
  await act('v', 300)
  log = await until('the forgery page', log => messages(log.slice(mark), 'forge').some(e => e.data.ready) && navigations(log).some(e => String(e.url).endsWith('/forge')), 15000)
  const tries = messages(log.slice(mark), 'forge').find(e => e.data.ready).data.tries
  record('the page reaches no Kybern handler or binding in its own world', tries.webkit === 'unreachable' && tries.binding === 'unreachable' && tries.pushState === '#two', tries)
  await act('q', 1500)
  const install = (await result()).install
  await act('w', 1500)
  const started2 = (await result()).start
  await act('o', 1200)
  const world = (await result()).page
  log = (await inspect()).log
  record("the picker installs and starts in Kybern's world, not the page's predefined one", install === 'ready' && started2 === 'picking' && world?.picker === 'object' && world?.hasBinding === 'function' && !messages(log.slice(mark), 'forge').some(e => e.data.fake), { install, started: started2, world })
  const navigationsBefore = navigations(log).length
  await act('y', 300)
  log = await until('the synthetic events', log => messages(log.slice(mark), 'forge').filter(e => e.data.fired).length === 1, 5000)
  await Bun.sleep(600)
  log = (await inspect()).log
  record('synthetic ⌥-click, click, Enter, Escape and popstate while picking forge nothing', forged(log).length === 0 && navigations(log).length === navigationsBefore, { forged: forged(log), navigations: navigations(log).slice(navigationsBefore) })
  await click(win, ...page(140, 180))
  log = await until('a real click to pick', log => forged(log).some(e => e.data?.event === 'picked'), 5000)
  const picked = forged(log).filter(e => e.data?.event === 'picked')
  record('a real click while picking posts picked through the isolated binding', picked.length === 1 && picked[0].data.payload?.selector === '#target' && forged(log).length === 1, forged(log))
  await act('y', 300)
  log = await until('the synthetic events again', log => messages(log.slice(mark), 'forge').filter(e => e.data.fired).length === 2, 5000)
  await Bun.sleep(600)
  log = (await inspect()).log
  record('synthetic ⌥-clicks outside picking forge no anchor', forged(log).length === 1, forged(log))
  const beforeBack = navigations(log).length
  await act('b', 300)
  log = await until('history.back in the isolated world', log => navigations(log).length > beforeBack, 5000)
  const back = navigations(log).at(-1)
  record("action back uses the isolated world's history, not the page's override", String(back.url).endsWith('/forge') && !messages(log.slice(mark), 'forge').some(e => e.data.fake), back)
  await clickWith(win, ...page(140, 180), [0x12])
  log = await until('a real ⌥-click', log => forged(log).some(e => e.data?.event === 'anchor'), 3000).catch(() => null) ?? (await inspect()).log
  const anchor = forged(log).find(e => e.data?.event === 'anchor')
  note('a real ⌥-click posts an anchor (WebView2 input carries Alt from the keyboard state)', !!anchor, anchor?.data ?? forged(log))

  await act('x', 800)
  log = (await inspect()).log
  shot = capture(win, path.join(out, '09-destroyed.png'))
  record('destroy removes the page', log.some(e => e.type === 'destroyed') && near(shot.at(...page(300, 60)), BACKGROUND))
  record('no navigation was blocked or failed', !log.some(e => e.type === 'failed' || e.type === 'terminated'), log.filter(e => e.type === 'failed' || e.type === 'terminated' || e.type === 'externalNavigation'))
  record('the child frame reports its navigation', log.some(e => e.type === 'navigation' && String(e.url).startsWith('http://127.0.0.1:')), log.filter(e => e.type === 'navigation'))
} catch (error) {
  failed = true
  record('check aborted', false, String((error as Error).stack ?? error))
  try { console.error(fixture.diagnostics()) } catch {}
} finally {
  await fixture.close()
  writeFileSync(path.join(out, 'webview-win.json'), JSON.stringify({ results, notes, failed }, null, 2))
}
const failures = results.filter(r => !r.ok)
console.log(`${results.length - failures.length}/${results.length} passed`)
assert.equal(failures.length, 0, failures.map(f => f.step).join('\n'))
