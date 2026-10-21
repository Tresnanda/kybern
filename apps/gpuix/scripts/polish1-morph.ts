// Image morph evidence against `polish1-seed.ts` (the "Images" thread, two composer attachments): for each surface (an agent
// reply image, a user message thumbnail, a composer attachment) frame strips of the pointer open, the pointer close, a close
// during the open and an Escape close, on the paused automation clock; with `--timing` instead, real-time frame intervals
// (`KYBERN_FRAME_TIMES`) over each open and close, no screenshots.
//   bun native/ui-lease.ts polish1 bun scripts/polish1-morph.ts [--theme dark|light|both] [--reduced 0|1|both] [--timing]
import '../src/native/local-build.ts'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../native/frame-harness.ts'

const arg = (name: string, fallback: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : fallback)
const SCRATCH = process.env.TRAY_SCRATCH ?? '/Users/mymac/projects/ade-gpuix-scratch/polish1'
const ready = JSON.parse(readFileSync(path.join(SCRATCH, 'ready.json'), 'utf8'))
const themes = arg('--theme', 'both') === 'both' ? ['dark', 'light'] : [arg('--theme', 'dark')]
const reduceds = arg('--reduced', 'both') === 'both' ? ['0', '1'] : [arg('--reduced', '0')]
const timing = process.argv.includes('--timing')
const out = arg('--out', '/Users/mymac/projects/ade/previews/polish1/morph')
const addon = path.resolve(arg('--addon', path.resolve(import.meta.dir, '../native/build')), 'gpuix-native.darwin-arm64.node')
const IMAGE = path.resolve(import.meta.dir, '../../desktop/public/release-background.png')
const SECOND = path.resolve(import.meta.dir, '../../desktop/src-tauri/icons/128x128@2x.png')
const grid = path.join(import.meta.dir, 'render9-grid.swift')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const OPEN = [0, 50, 100, 150, 200, 250, 300, 350, 450, 600]
const CLOSE = [0, 50, 100, 150, 200, 250, 300, 400]
const stats = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b), q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0
  return { n: v.length, p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), p99: +q(0.99).toFixed(1), max: +(s.at(-1) ?? 0).toFixed(1), over16: v.filter(x => x > 16.7 * 1.5).length, over33: v.filter(x => x > 33.4).length }
}
const report: string[] = []
mkdirSync(out, { recursive: true })
for (const theme of themes) for (const reduced of reduceds) {
  const label = `${theme}-${reduced === '1' ? 'reduced' : 'normal'}`
  const dir = path.join(out, label)
  mkdirSync(dir, { recursive: true })
  const client = path.join(SCRATCH, `client-morph-${theme}`)
  rmSync(client, { recursive: true, force: true })
  rmSync(path.join(SCRATCH, 'data', 'gpuix-ui.json'), { force: true })
  const f = await launchFixture(path.resolve(import.meta.dir, '../src/main.tsx'), {
    GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: reduced, KYBERN_URL: ready.url, KYBERN_TOKEN: ready.token,
    KYBERN_DATA_DIR: path.join(SCRATCH, 'data'), KYBERN_CLIENT_CONFIG_DIR: client, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(SCRATCH, 'credentials'),
    KYBERN_GPUIX_THREAD: 'Images', KYBERN_GPUIX_ATTACH: [IMAGE, SECOND].join(','), NAPI_RS_NATIVE_LIBRARY_PATH: addon, KYBERN_GPUIX_RESOURCES: '', KYBERND: '',
    ...(timing ? { KYBERN_FRAME_TIMES: '1' } : {}),
  })
  try {
    const a = f.app
    await a.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
    await a.getByTestId('attachment-image1').waitFor({ timeoutMs: 30_000 })
    await sleep(3000)
    const page = await a.getByTestId('app-ready').bounds()
    const center = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
    // A thumbnail fully on screen, above the composer.
    const composerTop = (await a.getByTestId('composer-overlay').bounds()).y
    const onScreen = async (thumbnail: boolean) => {
      const nodes = (await a.getByTestId('response-image').all()).filter(n => n.bounds && (n.bounds.width <= 64) === thumbnail)
      return nodes.find(n => n.bounds!.y >= 60 && n.bounds!.y + n.bounds!.height <= composerTop - 8)
    }
    let reply = await onScreen(false)
    if (!reply) throw Error('no reply image on screen')
    let thumb = await onScreen(true)
    void page
    const click = async (p: { x: number; y: number }) => { await a.mouse.move(p); await a.mouse.down(p); await a.mouse.up(p) }
    const surfaces = [
      { name: 'reply', viewer: 'image-lightbox', at: async () => center(reply!.bounds!) },
      // The user's message is the first turn: scroll it into view first.
      { name: 'user', viewer: 'image-lightbox', at: async () => {
        for (let i = 0; i < 12 && !thumb; i++) { await a.getByTestId('transcript-surface').wheel(0, 120); await sleep(150); thumb = await onScreen(true) }
        if (!thumb) throw Error('no user thumbnail on screen')
        return center(thumb.bounds!)
      } },
      { name: 'composer', viewer: 'attachment-lightbox', at: async () => center(await a.getByTestId('attachment-image1').bounds()) },
    ]
    const off = { x: 30, y: 30 }
    for (const surface of surfaces) {
      const s = { ...surface, at: await surface.at() }
      const closeAt = async () => center(await a.getByTestId(`${s.viewer}-close`).bounds())
      if (timing) {
        // Real time: frame intervals over the open (450 ms) and the close (400 ms), five times each.
        const opens: number[] = [], closes: number[] = []
        for (let i = 0; i < 5; i++) {
          const t0 = f.frameTimes().length
          await click(s.at); await a.mouse.move(off); await sleep(700)
          const o = f.frameTimes().slice(t0)
          const c0 = f.frameTimes().length
          await click(await closeAt()); await a.mouse.move(off); await sleep(700)
          const c = f.frameTimes().slice(c0)
          const intervals = (t: number[]) => t.slice(1).map((v, j) => v - t[j]!).filter(d => d < 250)
          opens.push(...intervals(o)); closes.push(...intervals(c))
        }
        report.push(`${label} ${s.name} open  ${JSON.stringify(stats(opens))}`, `${label} ${s.name} close ${JSON.stringify(stats(closes))}`)
        continue
      }
      await a.clock.pause()
      const run = async (id: string, trigger: () => Promise<void>, offsets: number[]) => {
        await trigger()
        const frames: string[] = []
        let at = 0
        for (const o of offsets) {
          if (o > at) await a.clock.fastForward(o - at)
          at = o
          await sleep(40)
          const file = path.join(dir, `${s.name}-${id}-${String(o).padStart(3, '0')}.png`)
          await a.screenshot({ path: file })
          execFileSync('sips', ['-Z', '720', file], { stdio: 'ignore' })
          frames.push(file)
        }
        const { pixelWidth: w, pixelHeight: h } = Object.fromEntries(execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', frames[0]!]).toString().split('\n').slice(1).filter(Boolean).map(l => l.trim().split(': ')).map(([k, v]) => [k, Number(v)]))
        execFileSync('swift', [grid, path.join(out, `${label}-${s.name}-${id}.png`), '0', '0', String(w), String(h), '5', ...frames])
        for (const file of frames) rmSync(file)
        await a.clock.fastForward(800)
      }
      await run('open', () => click(s.at), OPEN)
      await run('close', async () => { await click(await closeAt()); await a.mouse.move(off) }, CLOSE)
      // A close 150 ms into the open retargets from the image on screen.
      await run('interrupt', async () => { await click(s.at); await a.clock.fastForward(150); await click(off) }, CLOSE)
      // Keyboard: Enter opens and Escape closes, both at once.
      await run('keyboard', async () => {
        const target = s.name === 'composer' ? (await a.getByTestId('attachment-image1').element()).id : (s.name === "reply" ? reply! : thumb!).id
        await a.call('focus', { elementId: target }); await a.call('keyDown', { key: 'enter' })
      }, [0, 16])
      await run('escape', () => a.call('keyDown', { key: 'escape' }).then(() => {}), [0, 16])
      await a.clock.resume()
    }
  } finally { await f.close() }
  console.log(`[morph] ${label}`)
}
if (timing) { writeFileSync(path.join(out, 'TIMING.txt'), `KYBERN_FULL_RATE unset (default), hidden 1440x900@2x 60 Hz test display, addon ${path.basename(path.dirname(addon))}; frame intervals in ms (over16 = >25 ms, i.e. a skipped vsync)\n${report.join('\n')}\n`); console.log(report.join('\n')) }
process.exit(0)
