// motion10 press strips: a sample of the controls wired in motion10, pressed with real mouse down/up and stepped frame by frame.
// Desktop row: the desktop's motion CSS in WebKit (motion10-press-webkit.mjs); GPUIX row: motion10-press-lab.tsx with the native
// automation clock paused and stepped (visual strips only). Also writes metrics.json: each control's left edge on its middle row
// per frame (the press scale about the centre moves it right), for both rows. Run under one UI lease:
//   bun native/ui-lease.ts motion10 bun scripts/motion10-press-strips.ts [--theme dark|light|both] [--reduced 0|1|both]
import '../src/native/local-build.ts'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../src/tasks/round7b-harness.ts'
import { THEMES } from '../src/theme.ts'
import { SLASH_ICON } from '../src/editor/icons.ts'
import { pngPixels } from '../native/clip-pixels.ts'
const arg = (name: string, fallback: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : fallback)
const themes = arg('--theme', 'both') === 'both' ? ['dark', 'light'] as const : [arg('--theme', 'dark')] as ('dark' | 'light')[]
const reduceds = arg('--reduced', 'both') === 'both' ? ['0', '1'] : [arg('--reduced', '0')]
const root = '/Users/mymac/projects/ade/previews/gpuix/phase2/motion10/press'
const scratch = { KYBERN_DATA_DIR: '/Users/mymac/projects/ade-gpuix-scratch/motion10', KYBERN_CLIENT_CONFIG_DIR: '/Users/mymac/projects/ade-gpuix-scratch/motion10-client', KYBERN_URL: '', KYBERN_TOKEN: '' }
const PLAYWRIGHT_CORE = process.env.PLAYWRIGHT_CORE ?? '/Users/mymac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
// Logical rectangles of each control (both rows).
const CONTROLS = { 'press-action': { x: 24, y: 24, w: 60, h: 28 }, 'press-env': { x: 24, y: 72, w: 90, h: 32 }, 'press-format': { x: 160, y: 24, w: 28, h: 28 }, 'press-footer': { x: 160, y: 72, w: 168, h: 28 } } as const
const DOWN = [0, 20, 40, 60, 80], UP = [0, 50, 100, 150]
const lum = (p: number[]) => 0.2126 * p[0]! + 0.7152 * p[1]! + 0.0722 * p[2]!
const leftEdge = (file: string, c: { x: number; y: number; h: number }, top: number) => {
  const img = pngPixels(file), y = (c.y + c.h / 2 + top) * 2, bg = lum(img.at(4, y))
  for (let x = (c.x - 6) * 2; x < (c.x + 40) * 2; x++) if (Math.abs(lum(img.at(x, y)) - bg) > 6) return x / 2
  return -1
}
for (const theme of themes) for (const reduced of reduceds) {
  const label = `${theme}-${reduced === '1' ? 'reduced' : 'normal'}`, dir = path.join(root, label)
  mkdirSync(dir, { recursive: true })
  const t = THEMES[theme]
  const tokens = { background: t.v('--background'), primary: t.buttonPrimary, primaryText: t.buttonPrimaryText, textSecondary: t.textSecondary, hover: t.hover, hover2: t.buttonSecondaryHover, muted: t.textSecondary }
  execFileSync('node', [path.join(import.meta.dir, 'motion10-press-webkit.mjs'), path.join(dir, 'webkit'), theme, reduced, JSON.stringify(tokens), SLASH_ICON.heading1], { env: { ...process.env, PLAYWRIGHT_CORE }, stdio: 'inherit' })
  const f = await launchFixture(path.join(import.meta.dir, 'motion10-press-lab.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: reduced, KYBERN_OPAQUE: '1', ...scratch })
  const frames: Record<string, string[]> = {}
  try {
    const a = f.app; await a.getByTestId('app-ready').waitFor()
    const windowId = execFileSync('swift', [path.join(import.meta.dir, '../src/tasks/round7-window-id.swift'), String(f.pid)], { encoding: 'utf8' }).trim()
    const gdir = path.join(dir, 'gpuix'); mkdirSync(gdir, { recursive: true })
    const shot = async (name: string) => { await sleep(120); const file = path.join(gdir, `${name}.png`); execFileSync('screencapture', ['-x', '-o', '-l', windowId, file]); return file }
    await sleep(600)
    await a.clock.pause()
    const steps = async (offsets: number[], prefix: string, id: string) => {
      let at = 0
      for (const o of offsets) { if (o > at) await a.clock.fastForward(o - at); at = o; (frames[id] ??= []).push(await shot(`${prefix}-${String(o).padStart(3, '0')}`)) }
      await a.clock.fastForward(400)
    }
    for (const id of Object.keys(CONTROLS)) {
      const c = CONTROLS[id as keyof typeof CONTROLS], at = { x: c.x + c.w / 2, y: c.y + c.h / 2 }
      await a.mouse.move(at); await a.clock.fastForward(200); (frames[id] ??= []).push(await shot(`${id}-rest`))
      await a.mouse.down(at); await steps(DOWN, `${id}-down`, id)
      await a.mouse.up(at); await steps(UP, `${id}-up`, id)
      await a.mouse.move({ x: 340, y: 130 }); await a.clock.fastForward(200)
    }
    await a.clock.resume()
  } finally { await f.close() }
  const metrics: Record<string, { frame: string; desktop: number; gpuix: number }[]> = {}
  for (const id of Object.keys(CONTROLS)) {
    const c = CONTROLS[id as keyof typeof CONTROLS], gpuix = frames[id]!, webkit = gpuix.map(file => path.join(dir, 'webkit', path.basename(file)))
    execFileSync('swift', [path.join(import.meta.dir, 'render9-grid.swift'), path.join(dir, `${id}-strip.png`), String((c.x - 8) * 2), String((c.y - 6) * 2), String((c.w + 16) * 2), String((c.h + 12) * 2), String(webkit.length), ...webkit, ...gpuix.flatMap(file => ['top:64', file])])
    metrics[id] = gpuix.map((file, i) => ({ frame: path.basename(file, '.png'), desktop: leftEdge(webkit[i]!, c, 0), gpuix: leftEdge(file, c, 32) }))
  }
  writeFileSync(path.join(dir, 'metrics.json'), JSON.stringify(metrics, null, 2))
  writeFileSync(path.join(dir, 'README.txt'), `Top row: desktop motion CSS in WebKit; bottom row: GPUIX (motion10-press-lab.tsx), ${label}.\nPer control: rest, down ${DOWN.join('/')} ms, up ${UP.join('/')} ms.\nmetrics.json: left edge (logical px) of each control on its middle row, per frame.\n`)
  console.log(`ok ${label}`)
  for (const [id, rows] of Object.entries(metrics)) console.log(`  ${id.padEnd(14)} desktop ${rows.map(r => r.desktop.toFixed(1)).join(' ')}\n  ${''.padEnd(14)} gpuix   ${rows.map(r => r.gpuix.toFixed(1)).join(' ')}`)
}
process.exit(0)
