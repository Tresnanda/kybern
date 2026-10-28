// The Preferences scene's permission list never shows the full-access orange unless Full access is picked. Captured as WindowServer
// presents the window (`screencapture -l`, real time: retained paint and island replays included, which the automation screenshot
// re-renders away), many frames while the theme, the window material, the Adjust disclosure and a slider change.
//   bun scripts/onboarding-orange-check.ts [--theme dark|light]
// Starts its own scratch daemon (BENCH_SCRATCH, BENCH_PORT) and stops every daemon serving that data dir when it ends.
import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pixels } from '../native/png.ts'
import { launchFixture } from '../src/requests/harness.ts'

/** `--rendered`: capture with the addon's `captureScreenshot` (what the theme cross-fade holds as its picture) instead of WindowServer. */
const rendered = process.argv.includes('--rendered')
const theme = process.argv.includes('--theme') ? process.argv[process.argv.indexOf('--theme') + 1]! : 'dark'
const repo = path.resolve(import.meta.dir, '../../..')
const dir = path.join(process.env.BENCH_SCRATCH ?? path.join(tmpdir(), 'kybern-onboarding-bench'), `orange-${process.pid}`)
const data = path.join(dir, 'data')
const shots = path.join(dir, 'shots')
const port = Number(process.env.BENCH_PORT ?? 4391)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
rmSync(dir, { recursive: true, force: true })
mkdirSync(data, { recursive: true }); mkdirSync(shots, { recursive: true })
const env = { ...process.env }; delete env.KYBERN_URL; delete env.KYBERN_TOKEN
const daemon = spawn(path.join(repo, 'target', 'debug', 'kybernd'), ['--data-dir', data, '--port', String(port)], { env, stdio: 'ignore' })
for (let i = 0; i < 100 && !existsSync(path.join(data, 'daemon.port')); i++) await sleep(100)
await sleep(300)

/** The full-access orange in both themes (`theme.ts` `fullAccess`: #fe8549 dark, #e25505 light) and its tints over the canvas. */
const orange = ([r, g, b]: number[]) => r! > 150 && r! - b! > 70 && r! - g! > 35 && g! > b!

const f = await launchFixture(path.join(import.meta.dir, '..', 'src/main.tsx'), {
  GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_WINDOW_SIZE: '1440x900', KYBERN_ONBOARDING: '1', KYBERN_ONBOARDING_SCENE: 'prefs',
  ...(process.env.ORANGE_TRACE ? { KYBERN_MOTION_TRACE: '1', KYBERN_DEBUG_ISLANDS: '1' } : {}),
  KYBERN_DATA_DIR: data, KYBERN_CLIENT_CONFIG_DIR: path.join(dir, 'client'), KYBERN_GPUIX_CREDENTIALS_DIR: path.join(dir, 'credentials'), KYBERN_URL: '', KYBERN_TOKEN: '',
}, { stderr: (chunk) => { if (process.env.ORANGE_TRACE) appendFileSync(path.join(dir, 'trace.log'), chunk) } })
let failures = 0
try {
  const a = f.app
  await a.getByTestId('prefs-mode-supervised').waitFor({ timeoutMs: 60000 })
  await sleep(2500)
  const id = rendered ? 'app' : /window (\d+) onscreen=true/.exec(spawnSync('swift', [path.join(import.meta.dir, '../perf/bench/window-onscreen.swift'), String(f.pid)]).stdout.toString())?.[1]
  assert.ok(id, 'the window is not on screen')
  const first = await a.getByTestId('prefs-mode-supervised').bounds()
  const last = await a.getByTestId('prefs-mode-full-access').bounds()
  const box = { x: first.x - 8, y: first.y - 8, width: first.width + 16, height: last.y + last.height - first.y + 16 }
  const win = await a.getByTestId('onboarding').bounds()
  let n = 0
  /** Orange pixels inside the list in one capture of the window as presented. */
  const capture = async (label: string) => {
    const file = path.join(shots, `${String(++n).padStart(3, '0')}-${label}.png`)
    if (process.env.ORANGE_TRACE_ONLY) { await sleep(60); return 0 }
    if (rendered) await a.screenshot({ path: file })
    else if (spawnSync('screencapture', ['-x', '-o', '-l', id, file]).status !== 0) return -1
    const p = pixels(file), scale = p.w / win.width, top = p.h / scale - win.height
    let count = 0
    for (let y = box.y; y < box.y + box.height; y += 1) for (let x = box.x; x < box.x + box.width; x += 1) if (orange(p.at(x * scale, (y + top) * scale))) count++
    return count
  }
  const mark = (label: string) => { if (process.env.ORANGE_TRACE) appendFileSync(path.join(dir, 'trace.log'), `\n[mark] ${label}\n`) }
  const before = await capture('rest')
  console.log(`rest: ${before} orange px`)
  assert.equal(before, 0, 'orange in the list at rest with Ask for approval picked')
  const click = async (testId: string) => { const c = await a.getByTestId(testId).center(); await a.mouse.click(c) }
  const watch = async (label: string, action: () => Promise<unknown>, ms = 900) => {
    const counts: number[] = []
    mark(label)
    const done = action()
    const end = Date.now() + ms
    while (Date.now() < end) counts.push(await capture(label))
    await done
    // Outside Full access the orange layer is not mounted at all, so no draw can paint it (PermissionList.tsx).
    const tints = await a.getByTestId('prefs-mode-tint').count()
    if (label !== 'full-access' && tints > 0) { console.log(`${label}: the full-access tint is mounted`); failures++ }
    const worst = Math.max(...counts)
    console.log(`${label}: ${counts.length} frames, orange px per frame ${counts.join(',')}`)
    if (worst > 0) failures++
  }
  await watch('theme-light', () => click('prefs-theme-light'))
  await watch('theme-dark', () => click('prefs-theme-dark'))
  await watch('material-full', () => click('prefs-material-full'))
  await watch('adjust', () => click('prefs-adjust'))
  // Adjust remembers whether it was open, so that press may have closed it: its sliders are then leaving (still listed for their
  // exit). Look once they are settled, and open it again if none stayed.
  const findSlider = async () => {
    await sleep(500)
    const id = (await a.getByType('div').all()).find((node) => node.testId?.startsWith('prefs-slider-'))?.testId
    return id && (await a.getByTestId(id).count()) > 0 ? id : undefined
  }
  let slider = await findSlider()
  if (!slider) { await watch('adjust-again', () => click('prefs-adjust')); slider = await findSlider() }
  if (slider) await watch('slider', () => a.getByTestId(slider).dragBy(-80, 0, { steps: 24 } as never), 1200)
  await watch('material-sidebar', () => click('prefs-material-sidebar'))
  await watch('material-solid', () => click('prefs-material-solid'))
  await watch(theme === 'dark' ? 'theme-system' : 'theme-system', () => click('prefs-theme-system'))
  // The control: Full access does turn it orange, so the detector sees the colour.
  await watch('full-access', () => click('prefs-mode-full-access'), 700)
  if (process.env.ORANGE_TRACE) console.log(`tint element ${(await a.getByTestId('prefs-mode-tint').element() as { id?: number }).id}`)
  const control = await capture('full-access-rest')
  console.log(`full access at rest: ${control} orange px`)
  if (!process.env.ORANGE_TRACE_ONLY) assert.ok(control > 200, 'the detector did not see Full access')
  await click('prefs-mode-supervised')
} finally {
  await f.close(); daemon.kill()
  spawnSync('pkill', ['-f', `kybernd.*${data}`])
}
if (process.env.ORANGE_TRACE) console.log(`trace: ${path.join(dir, 'trace.log')}`)
console.log(failures ? `FAIL: orange appeared in ${failures} change(s); frames in ${shots}` : `ok ${theme}: no orange outside Full access (frames in ${shots})`)
process.exit(failures ? 1 : 0)
