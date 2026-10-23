// Work runs on screen (ADE-54..58 L5): a busy live turn and a settled one, in Solid dark, whole-window glass dark and Solid
// light, plus an open run with its chips and a 50 ms frame sequence of calls arriving. The full app runs on the glass
// scratch daemon (`perf/glass/`) with `work.app.ts` streaming `perf/bench/workTurn.ts` into its thread.
//
//   KYBERN_DATA_DIR=<…gpuix-scratch…/data> bun src/transcript/work.verify.ts <out-dir> <tag> [sessions, e.g. dark,glass,light]
//
// Images are GPUI's own render of the window (`render-capture`, independent of the window server); glass frames are
// composited over a flat grey desktop. Run the same script on the old sources for the "before" set.
import '../native/local-build.ts'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import path from 'node:path'
import { pixels } from '../../native/png.ts'
import { onExit } from '../../perf/bench/lifetime.ts'
import { controlFor, ensureTestDisplay, waitForQuiet } from '../../perf/glass/harness.ts'
import { seedGlass } from '../../perf/glass/seed.ts'
import { launchFixture } from '../requests/harness.ts'
import { assertScratchDataDir, until } from '../platform/verify.lib.ts'

assertScratchDataDir()
const GPUIX = path.resolve(import.meta.dir, '../..')
const [outArg, tag = 'after', only = 'dark,glass,light'] = process.argv.slice(2)
const OUT = path.resolve(outArg ?? '/Users/mymac/projects/ade/.kybern-artifacts/ade-54-58/L5')
if (OUT.startsWith(path.resolve(GPUIX, '../..') + path.sep)) throw Error(`Refusing to write captures into the repository (${OUT})`)
mkdirSync(OUT, { recursive: true })

if (!(await waitForQuiet())) throw Error('Another agent\'s native build or check is still running after 20 minutes.')
const fixture = await seedGlass()
const unFixture = onExit(() => fixture.close())
const stopDisplay = await ensureTestDisplay(path.join(fixture.extras, 'bin'))
const unDisplay = onExit(stopDisplay)

/** RGBA render over a flat grey desktop, as RGB PNG (glass frames carry the window's alpha). */
function writeOver(file: string, out: string) {
  const img = pixels(file) as { w: number; h: number; channels: number; data: Uint8Array }
  const row = img.w * 3 + 1, raw = Buffer.alloc(row * img.h)
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const i = (y * img.w + x) * img.channels, a = img.channels === 4 ? img.data[i + 3]! / 255 : 1
    for (let c = 0; c < 3; c++) raw[y * row + 1 + x * 3 + c] = Math.min(255, Math.round(img.data[i + c]! + 128 * (1 - a)))
  }
  const crc = (buf: Buffer) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) } return ~c >>> 0 }
  const chunk = (type: string, data: Buffer) => { const t = Buffer.concat([Buffer.from(type), data]), o = Buffer.alloc(12 + data.length); o.writeUInt32BE(data.length, 0); t.copy(o, 4); o.writeUInt32BE(crc(t), 8 + data.length); return o }
  const head = Buffer.alloc(13); head.writeUInt32BE(img.w, 0); head.writeUInt32BE(img.h, 4); head[8] = 8; head[9] = 2
  writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
}

const SESSIONS: Record<string, { theme: string; pins: Record<string, string> }> = {
  dark: { theme: 'dark', pins: { KYBERN_WINDOW_MATERIAL: 'solid' } },
  glass: { theme: 'dark', pins: { KYBERN_WINDOW_MATERIAL: 'window', KYBERN_WINDOW_OPACITY: '83', KYBERN_WINDOW_CONTENT_OPACITY: '83' } },
  light: { theme: 'light', pins: { KYBERN_WINDOW_MATERIAL: 'solid' } },
}
const PINS = ['KYBERN_WINDOW_MATERIAL', 'KYBERN_WINDOW_OPACITY', 'KYBERN_WINDOW_CONTENT_OPACITY', 'KYBERN_WINDOW_SURFACE_OPACITY', 'KYBERN_GLASS_FROST', 'KYBERN_REDUCED_TRANSPARENCY', 'KYBERN_INCREASED_CONTRAST']

for (const name of only.split(',')) {
  const session = SESSIONS[name]!
  const client = path.join(fixture.extras, 'clients', `work-${name}`)
  rmSync(client, { recursive: true, force: true }); mkdirSync(client, { recursive: true })
  const run = await launchFixture(path.join(GPUIX, 'src/transcript/work.app.ts'), {
    ...fixture.env, ...Object.fromEntries(PINS.map((k) => [k, ''])), ...session.pins, KYBERN_WINDOW_BLUR: '64',
    KYBERN_CLIENT_CONFIG_DIR: client, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(client, 'credentials'), KYBERN_GPUIX_ENVIRONMENT: 'local',
    KYBERN_GPUIX_THREAD: fixture.manifest.thread, KYBERN_GLASS_THREAD: fixture.manifest.thread,
    GPUIX_BACKGROUND: '1', KYBERN_BENCH_LAYER_ZERO: '1', KYBERN_PACING_IGNORE_PHYSICAL_MOUSE: '1', KYBERN_APPEARANCE: session.theme,
    KYBERN_REDUCED_MOTION: process.env.KYBERN_REDUCED_MOTION ?? '', KYBERN_WINDOW_SIZE: '1000x900',
  })
  try {
    const app = run.app
    await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
    const glass = await controlFor(client)
    const work = await controlFor(client).then(() => {
      const file = path.join(client, 'work-control.json')
      return async <T = Record<string, unknown>>(action: string, args: object = {}) => {
        const { port } = JSON.parse(await Bun.file(file).text()) as { port: number }
        const res = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: JSON.stringify({ action, ...args }) })
        const body = await res.json() as T & { error?: string }
        if (!res.ok) throw Error(`work ${action}: ${body.error}`)
        return body
      }
    })
    await glass('open-fixture-thread')
    await until(async () => { const s = await glass<{ selected: string; loaded: boolean; blocks: number }>('state'); return s.selected === fixture.manifest.thread && s.loaded && s.blocks > 0 }, 'the thread loads', 30_000)
    await app.mouse.move({ x: 24, y: 640 })
    const shot = async (state: string) => {
      const scene = path.join(OUT, `${tag}-${name}-${state}.scene.png`)
      await glass('render-capture', { path: scene })
      writeOver(scene, path.join(OUT, `${tag}-${name}-${state}.png`))
      rmSync(scene, { force: true })
    }
    // A busy live turn: three segments of history (stamped 40 s back, so nothing animates), then live calls arriving.
    await work('turn', { turn: `work-live-${name}`, history: 44, ago: 40 })
    await work('feed', { count: 400, intervalMs: 160 })
    await Bun.sleep(2600)
    await shot('live')
    // Arrivals: ~1.6 s of frames 50 ms apart (each capture takes its own time; the sequence records when each landed).
    const stamps: number[] = []
    const t0 = performance.now()
    for (let i = 0; i < 24; i++) { await shot(`arrive-${String(i).padStart(2, '0')}`); stamps.push(Math.round(performance.now() - t0)); const next = t0 + (i + 1) * 50; if (next > performance.now()) await Bun.sleep(next - performance.now()) }
    writeFileSync(path.join(OUT, `${tag}-${name}-arrive.json`), JSON.stringify({ intervalMs: 50, capturedAtMs: stamps }))
    // Motion strips: the native clock paused, one event applied, then a frame every 50 ms of animation time.
    const strip = async (label: string) => {
      const at = await app.clock.pause()
      await work('step', { count: 1 })
      await Bun.sleep(300)
      for (let o = 0; o <= 600; o += 50) { await app.clock.set(at + o); await Bun.sleep(40); await shot(`${label}-${String(o).padStart(3, '0')}ms`) }
      await app.clock.resume()
    }
    // The next run opens as it mounts (its calls arrive into an open group); then its second call arrives.
    const { segment } = await work<{ segment: number }>('open-next')
    await work('step', { to: segment * 15 + 9 })
    await Bun.sleep(900)
    await strip('strip-call')
    // A new run after narration (the following segment's first call).
    await work('step', { to: (segment + 1) * 15 + 7 })
    await Bun.sleep(900)
    await strip('strip-run')
    await work('feed', { count: 400, intervalMs: 160 })
    await Bun.sleep(1500)
    await shot('live-open')
    // Settled: the fold closes on its own; open "Worked for" and the run inside it.
    await work('settle', {})
    await Bun.sleep(2000)
    await shot('settled')
    await app.getByTestId(`worked-work-live-${name}`).click()
    await Bun.sleep(900)
    await shot('settled-open')
    console.log(`[work] ${tag} ${name}: done`)
  } catch (error) {
    console.log(`FAIL ${name}: ${String(error).slice(0, 400)}\n${run.diagnostics().split('\n').filter((l) => !l.includes('[pacing-commit]')).join('\n').slice(-1200)}`)
  } finally { await run.close() }
}
unDisplay(); stopDisplay(); unFixture(); await fixture.close()
process.exit(0)
