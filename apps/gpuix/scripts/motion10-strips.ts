// motion10 strips: the success check (`t-success` transform + stroke draw) and the kit Checkbox's check draw (`t-check-path`),
// frame by frame. Desktop row: the desktop's motion CSS and markup in WebKit (motion10-webkit.mjs), animations paused at each
// offset. GPUIX row: scripts/motion10-lab.tsx with the native automation clock paused and stepped to the same offsets (visual
// strips only: never a timing run). Real mouse click on the checkbox. Run under one UI lease:
//   bun native/ui-lease.ts motion10 bun scripts/motion10-strips.ts [--theme dark|light|both] [--reduced 0|1|both]
import '../src/native/local-build.ts'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../src/tasks/round7b-harness.ts'
import { THEMES } from '../src/theme.ts'
import { N } from '../src/nav/glyphs.ts'
const arg = (name: string, fallback: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : fallback)
const themes = arg('--theme', 'both') === 'both' ? ['dark', 'light'] as const : [arg('--theme', 'dark')] as ('dark' | 'light')[]
const reduceds = arg('--reduced', 'both') === 'both' ? ['0', '1'] : [arg('--reduced', '0')]
const root = '/Users/mymac/projects/ade/previews/gpuix/phase2/motion10/strips'
const scratch = { KYBERN_DATA_DIR: '/Users/mymac/projects/ade-gpuix-scratch/motion10', KYBERN_CLIENT_CONFIG_DIR: '/Users/mymac/projects/ade-gpuix-scratch/motion10-client', KYBERN_URL: '', KYBERN_TOKEN: '' }
const PLAYWRIGHT_CORE = process.env.PLAYWRIGHT_CORE ?? '/Users/mymac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const OFFSETS = { checkbox: [0, 80, 90, 100, 110, 120, 140, 170, 230, 330], success: [0, 100, 150, 160, 170, 180, 190, 200, 220, 250, 300, 400, 500] }
// Scene rectangles (logical px) shared by both rows.
const SCENES = { checkbox: { x: 16, y: 16, w: 32, h: 32 }, success: { x: 292, y: 82, w: 56, h: 56 } }
for (const theme of themes) for (const reduced of reduceds) {
  const label = `${theme}-${reduced === '1' ? 'reduced' : 'normal'}`, dir = path.join(root, label)
  mkdirSync(dir, { recursive: true })
  const t = THEMES[theme]
  const tokens = { background: t.v('--background'), primary: t.v('--primary'), primaryForeground: t.v('--primary-foreground'), borderLight: t.v('--color-border-light'), success: t.v('--success'), cbFill: theme === 'dark' ? `color-mix(in srgb, ${t.v('--input')} 32%, transparent)` : t.v('--background') }
  execFileSync('node', [path.join(import.meta.dir, 'motion10-webkit.mjs'), path.join(dir, 'webkit'), theme, reduced, JSON.stringify(tokens), N.check], { env: { ...process.env, PLAYWRIGHT_CORE, MOTION10_OFFSETS: JSON.stringify(OFFSETS) }, stdio: 'inherit' })
  const f = await launchFixture(path.join(import.meta.dir, 'motion10-lab.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: reduced, KYBERN_OPAQUE: '1', ...scratch })
  const frames: Record<string, string[]> = {}
  try {
    const a = f.app; await a.getByTestId('app-ready').waitFor()
    const ready = (await a.getByTestId('app-ready').element()).id
    await a.call('focus', { elementId: ready })
    const windowId = execFileSync('swift', [path.join(import.meta.dir, '../src/tasks/round7-window-id.swift'), String(f.pid)], { encoding: 'utf8' }).trim()
    const gdir = path.join(dir, 'gpuix'); mkdirSync(gdir, { recursive: true })
    const shot = async (name: string) => { await sleep(120); const file = path.join(gdir, `${name}.png`); execFileSync('screencapture', ['-x', '-o', '-l', windowId, file]); return file }
    await sleep(600)
    await a.clock.pause()
    const steps = async (offsets: number[], prefix: string) => {
      let at = 0
      for (const o of offsets) { if (o > at) await a.clock.fastForward(o - at); at = o; (frames[prefix] ??= []).push(await shot(`${prefix}-${String(o).padStart(3, '0')}`)) }
      await a.clock.fastForward(600)
    }
    const cb = await a.getByTestId('cb').center()
    await a.mouse.move(cb); await a.mouse.down(cb); await a.mouse.up(cb)
    await steps(OFFSETS.checkbox, 'checkbox')
    await a.call('keyDown', { key: 's' }); await steps(OFFSETS.success, 'success')
    await a.clock.resume()
  } finally { await f.close() }
  const strips: string[] = []
  const strip = (name: keyof typeof SCENES) => {
    const s = SCENES[name], gpuix = frames[name]!, webkit = gpuix.map(file => path.join(dir, 'webkit', path.basename(file)))
    const out = path.join(dir, `${name}-strip.png`)
    execFileSync('swift', [path.join(import.meta.dir, 'render9-grid.swift'), out, String(s.x * 2), String(s.y * 2), String(s.w * 2), String(s.h * 2), String(webkit.length), ...webkit, ...gpuix.flatMap(file => ['top:64', file])])
    strips.push(out)
  }
  strip('checkbox'); strip('success')
  writeFileSync(path.join(dir, 'README.txt'), `Top row: desktop motion CSS + markup in WebKit; bottom row: GPUIX (motion10-lab.tsx), ${label}.\ncheckbox: ${OFFSETS.checkbox.join('/')} ms after the click\nsuccess: ${OFFSETS.success.join('/')} ms after mount\n`)
  console.log(`ok ${label}\n  ${strips.join('\n  ')}`)
}
process.exit(0)
