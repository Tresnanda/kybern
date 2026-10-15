/**
 * Capture the transcript's transitions frame by frame on a paused clock and
 * join each into one horizontal sheet (ffmpeg), cropped to the transcript.
 *
 *   KYBERN_DATA_DIR=<scratch> KYBERN_GPUIX_THREAD=<id> bun scripts/transcript-motion.ts settled <out-dir>
 *   KYBERN_DATA_DIR=<scratch> KYBERN_GPUIX_THREAD=<id> bun scripts/transcript-motion.ts live <out-dir> "<prompt>"
 *
 * `settled` opens and closes the disclosures of the last turn, shows and uses
 * the scroll-to-bottom button and copies the answer. `live` sends `<prompt>`
 * with the CLI (scratch daemon only) and captures the sent bubble, the first
 * live rows and the request card as they arrive. Nothing is approved here.
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { launch, type App } from '@gpuix/react/automation'

const [mode = 'settled', outArg = 'screenshots/transcript-motion', prompt = 'Reply with one short sentence.'] = process.argv.slice(2)
const out = path.resolve(outArg)
mkdirSync(out, { recursive: true })
const dataDir = process.env.KYBERN_DATA_DIR
const thread = process.env.KYBERN_GPUIX_THREAD
const CLI = process.env.KYBERN_CLI ?? '/Applications/kybern.app/Contents/MacOS/kybern'

function forwarded(): Record<string, string> {
  const keys = ['KYBERN_DATA_DIR', 'KYBERN_URL', 'KYBERN_TOKEN', 'KYBERN_GPUIX_THREAD', 'KYBERN_REDUCED_MOTION', 'KYBERN_OPAQUE']
  return Object.fromEntries(keys.flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const app = await launch({
  command: 'bun',
  args: [path.join(import.meta.dir, mode === 'lab' ? 'transcript-motion-lab.tsx' : '../src/main.tsx')],
  env: { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark', ...forwarded() },
})

/** Window-space crop for the sheets: the chat column (a virtual list reports
 *  no painted bounds of its own). `CROP=x:y:w:h` overrides it. */
async function region(_a: App) {
  const [x, y, w, h] = (process.env.CROP ?? '400:120:780:700').split(':').map(Number)
  return { x: x!, y: y!, w: w!, h: h! }
}

/** Join frames side by side, cropped to `crop` (window points; frames are scaled). */
function sheet(name: string, files: string[], crop: { x: number; y: number; w: number; h: number }, windowWidth: number) {
  const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'csv=p=0', files[0]!], { encoding: 'utf8' })
  const scale = Number(probe.trim()) / windowWidth
  const c = `crop=${Math.round(crop.w * scale)}:${Math.round(crop.h * scale)}:${Math.round(crop.x * scale)}:${Math.round(crop.y * scale)}`
  const inputs = files.flatMap((f) => ['-i', f])
  const chains = files.map((_, i) => `[${i}]${c},pad=iw+8:ih:0:0:#ff00ff[f${i}]`).join(';')
  const filter = `${chains};${files.map((_, i) => `[f${i}]`).join('')}hstack=inputs=${files.length}`
  const target = path.join(out, `${name}.png`)
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', filter, '-frames:v', '1', '-update', '1', target])
  console.log(`[motion] ${target} (${files.length} frames)`)
}

let windowWidth = 0
async function capture(name: string, act: () => Promise<void>, times: number[], settleMs = 120) {
  const crop = await region(app)
  const at = await app.clock.pause()
  await act()
  await sleep(settleMs) // measuring frame(s) before a tween starts
  const dir = path.join(out, name)
  rmSync(dir, { recursive: true, force: true })
  const files = await app.captureFrames(dir, times.map((t) => at + t))
  await app.clock.resume()
  await sleep(400)
  sheet(name, files, crop, windowWidth)
}

/** The nth element whose testId starts with `prefix` (negative from the end). */
async function byPrefix(prefix: string, nth = -1) {
  const nodes = (await app.getByType('div').all()).filter((n) => n.testId?.startsWith(prefix) && n.bounds && n.bounds.height > 0)
  const node = nodes.at(nth)
  if (!node?.bounds) throw new Error(`No element with testId ${prefix}* (${nodes.length} found)`)
  return node
}
async function clickPrefix(prefix: string, nth = -1) {
  const node = await byPrefix(prefix, nth)
  await app.mouse.click({ x: node.bounds!.x + Math.min(40, node.bounds!.width / 2), y: node.bounds!.y + Math.min(12, node.bounds!.height / 2) })
}
async function waitPrefix(prefix: string, timeoutMs = 60_000, count = 1) {
  const start = Date.now()
  for (;;) {
    const nodes = (await app.getByType('div').all()).filter((n) => n.testId?.startsWith(prefix))
    if (nodes.length >= count) return
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${prefix}`)
    await sleep(40)
  }
}

const DISCLOSURE = [0, 55, 110, 165, 260]
const ROW = [0, 60, 125, 190, 300]
const PANEL = [0, 90, 175, 260, 400]

try {
  const ready = await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  windowWidth = ready.bounds?.width ?? 0
  await sleep(Number(process.env.SETTLE_MS ?? 3000))
  if (!windowWidth) windowWidth = (await app.getByTestId('app-ready').bounds()).width
  if (mode === 'lab') {
    const all = { x: 0, y: 0, w: windowWidth, h: (await app.getByTestId('app-ready').bounds()).height }
    for (const name of ['scroll-button-in', 'scroll-button-out']) {
      const at = await app.clock.pause()
      await app.getByTestId('toggle').click()
      await sleep(60)
      const files = await app.captureFrames(path.join(out, name), [0, 60, 125, 190, 300].map((t) => at + t))
      await app.clock.resume()
      await sleep(400)
      sheet(name, files, all, windowWidth)
    }
  } else {
    await app.getByTestId('transcript').waitFor({ timeoutMs: 30_000 })
    await sleep(1000)
  }

  if (mode === 'burst') {
    // CPU of disclosure bursts: 15 s idle, then 15 s toggling the "Worked for"
    // fold once a second (each toggle is one 220 ms tween). Sample the app with
    // perf/sample.ts over each window; the pid is printed for that.
    console.log(`[motion] idle window`)
    await sleep(15_000)
    console.log(`[motion] burst window`)
    for (let i = 0; i < 15; i++) {
      await clickPrefix('worked-')
      await sleep(1000)
    }
    console.log(`[motion] done`)
  }
  if (mode === 'files') {
    await capture('file-open', () => clickPrefix('edited-file-'), DISCLOSURE, 400)
    await capture('file-close', () => clickPrefix('edited-file-'), DISCLOSURE, 40)
  }
  if (mode === 'settled') {
    await capture('worked-open', () => clickPrefix('worked-'), DISCLOSURE)
    await capture('tool-open', () => clickPrefix('tool-row-', 0), DISCLOSURE)
    await capture('tool-close', () => clickPrefix('tool-row-', 0), DISCLOSURE, 40)
    if ((await app.getByType('div').all()).some((n) => n.testId?.startsWith('thought-'))) {
      await capture('thought-open', () => clickPrefix('thought-', 0), DISCLOSURE)
    }
    await capture('worked-close', () => clickPrefix('worked-'), DISCLOSURE, 40)
    if (await app.getByTestId('edited-files-toggle').count()) {
      await capture('files-close', () => app.getByTestId('edited-files-toggle').click(), DISCLOSURE, 40)
      await capture('files-open', () => app.getByTestId('edited-files-toggle').click(), DISCLOSURE)
      await capture('file-open', () => clickPrefix('edited-file-', 0), DISCLOSURE, 600)
    }
  }
  if (mode === 'settled' || mode === 'extra') {
    // The check reverts after 1.4 s of real time, so capture few frames, fast.
    await capture('copy', () => clickPrefix('answer-copy'), [0, 80, 300], 0)
  }
  if (mode === 'live') {
    if (!dataDir || !thread) throw new Error('live needs KYBERN_DATA_DIR (scratch) and KYBERN_GPUIX_THREAD')
    // One pause for the whole turn: everything that mounts while the clock is
    // frozen starts its tween at `at`, however long the capture itself takes.
    const bubbles = await app.getByTestId('user-bubble').count()
    const toolRows = (await app.getByType('div').all()).filter((n) => n.testId?.startsWith('tool-row-')).length
    const crop = await region(app)
    const full = { x: 0, y: 0, w: windowWidth, h: (await app.getByTestId('app-ready').bounds()).height }
    const at = await app.clock.pause()
    const send = spawn(CLI, ['--data-dir', dataDir, 'send', thread, '--detach', prompt], { stdio: 'inherit' })
    await waitPrefix('user-bubble', 30_000, bubbles + 1)
    await waitPrefix('live-work', 30_000)
    await sleep(150)
    // SKIP_SEND=1: frames take seconds to render, long enough for the first
    // tool row to arrive mid-capture; skip the bubble to isolate the row.
    if (!process.env.SKIP_SEND) sheet('send', await app.captureFrames(path.join(out, 'send'), [0, 65, 130, 195, 320].map((t) => at + t)), crop, windowWidth)
    // captureFrames leaves the paused clock at its last frame: set a fresh base
    // before each wait so the next arrival's tween starts at a known time.
    // SKIP_ROW=1 isolates the request card the same way.
    let base = at
    if (!process.env.SKIP_ROW) {
      base = await app.clock.set(at + 10_000)
      await waitPrefix('tool-row-', 90_000, toolRows + 1)
      await sleep(150)
      sheet('live-row', await app.captureFrames(path.join(out, 'live-row'), ROW.map((t) => base + t)), crop, windowWidth)
      base = await app.clock.set(at + 20_000)
    }
    if (!(await app.getByTestId('thread-request').count())) {
      await waitPrefix('thread-request', 90_000)
      await sleep(300)
    }
    sheet('request', await app.captureFrames(path.join(out, 'request'), PANEL.map((t) => base + t)), full, windowWidth)
    await app.clock.resume()
    send.kill()
  }
} finally {
  await app.close()
}
