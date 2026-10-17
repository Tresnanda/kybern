// render9 motion strips: press feedback, whole-box attention pop, success check and the drop highlight, frame by frame.
// Desktop row: the desktop's motion CSS in WebKit (render9-motion-webkit.mjs), animations paused at each offset.
// GPUIX row: scripts/render9-motion-lab.tsx with the native automation clock paused and stepped to the same offsets
// (visual strips only: never a timing run). Real mouse down/up for the press, the native file-drag event for the drop.
//   bun scripts/render9-strips.ts [--theme dark|light|both] [--reduced 0|1|both]
import '../src/native/local-build.ts'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../src/tasks/round7b-harness.ts'
import { THEMES } from '../src/theme.ts'
const arg = (name: string, fallback: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : fallback)
const themes = arg('--theme', 'both') === 'both' ? ['dark', 'light'] as const : [arg('--theme', 'dark')] as ('dark' | 'light')[]
const reduceds = arg('--reduced', 'both') === 'both' ? ['0', '1'] : [arg('--reduced', '0')]
const root = '/Users/mymac/projects/ade/previews/gpuix/phase2/render9/strips'
const scratch = { KYBERN_DATA_DIR: '/Users/mymac/projects/ade-gpuix-scratch/phase2-render9', KYBERN_CLIENT_CONFIG_DIR: '/Users/mymac/projects/ade-gpuix-scratch/phase2-render9-client', KYBERN_URL: '', KYBERN_TOKEN: '' }
const PLAYWRIGHT_CORE = process.env.PLAYWRIGHT_CORE ?? '/Users/mymac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
// Scene rectangles (logical px) shared by both rows.
const SCENES = {
  press: { x: 16, y: 16, w: 140, h: 48 },
  pop: { x: 16, y: 82, w: 256, h: 72 },
  success: { x: 292, y: 82, w: 56, h: 56 },
  drop: { x: 372, y: 172, w: 216, h: 116 },
}
for (const theme of themes) for (const reduced of reduceds) {
  const label = `${theme}-${reduced === '1' ? 'reduced' : 'normal'}`, dir = path.join(root, label)
  mkdirSync(dir, { recursive: true })
  const t = THEMES[theme]
  const tokens = { background: t.v('--background'), primary: t.v('--primary'), primaryForeground: t.v('--primary-foreground'), iconPrimary: t.iconPrimary, borderLight: t.borderLight, composer: theme === 'dark' ? t.composer : '#ffffff', elevated: t.v('--color-background-elevated-secondary'), text: t.text, textSecondary: t.textSecondary, success: t.v('--success'), focus: t.v('--color-border-focus'), cardBorder: theme === 'dark' ? 'rgba(252, 252, 252, 0.052)' : 'rgba(13, 13, 13, 0.076)' }
  execFileSync('node', [path.join(import.meta.dir, 'render9-motion-webkit.mjs'), path.join(dir, 'webkit'), theme, reduced, JSON.stringify(tokens)], { env: { ...process.env, PLAYWRIGHT_CORE }, stdio: 'inherit' })
  const f = await launchFixture(path.join(import.meta.dir, 'render9-motion-lab.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: reduced, KYBERN_OPAQUE: '1', ...scratch })
  const frames: Record<string, string[]> = {}
  try {
    const a = f.app; await a.getByTestId('app-ready').waitFor()
    const root = (await a.getByTestId('app-ready').element()).id
    await a.call('focus', { elementId: root })
    const windowId = execFileSync('swift', [path.join(import.meta.dir, '../src/tasks/round7-window-id.swift'), String(f.pid)], { encoding: 'utf8' }).trim()
    const gdir = path.join(dir, 'gpuix'); mkdirSync(gdir, { recursive: true })
    const shot = async (name: string) => { await sleep(120); const file = path.join(gdir, `${name}.png`); execFileSync('screencapture', ['-x', '-o', '-l', windowId, file]); return file }
    const key = async (k: string) => { await a.call('keyDown', { key: k }) }
    await sleep(600)
    await a.clock.pause()
    const steps = async (offsets: number[], prefix: string) => {
      let at = 0
      for (const o of offsets) { if (o > at) await a.clock.fastForward(o - at); at = o; (frames[prefix] ??= []).push(await shot(`${prefix}-${String(o).padStart(3, '0')}`)) }
      await a.clock.fastForward(600)
    }
    const button = await a.getByTestId('press-kit').center()
    await a.mouse.move(button); frames['press-rest'] = [await shot('press-rest')]
    await a.mouse.down(button); await steps([0, 20, 40, 60, 80], 'press-down')
    await a.mouse.up(button); await steps([0, 50, 100, 150], 'press-up')
    await key('o'); await steps([0, 50, 100, 150, 200, 250], 'pop')
    await key('s'); await steps([0, 100, 200, 300, 400, 500], 'success')
    await key('d'); await steps([0, 50, 100, 150, 200], 'drop-in')
    await key('e'); await steps([0, 50, 100, 150, 200], 'drop-out')
    await a.clock.resume()
  } finally { await f.close() }
  // Strips: desktop row over GPUIX row (both 2x; GPUIX crops skip the 32 pt title bar).
  const strips: string[] = []
  const strip = (name: string, scene: keyof typeof SCENES, prefixes: string[]) => {
    const s = SCENES[scene], webkit = prefixes.flatMap(p => frames[p]!.map(file => path.join(dir, 'webkit', path.basename(file))))
    const gpuix = prefixes.flatMap(p => frames[p]!)
    const out = path.join(dir, `${name}-strip.png`)
    execFileSync('swift', [path.join(import.meta.dir, 'render9-grid.swift'), out, String(s.x * 2), String(s.y * 2), String(s.w * 2), String(s.h * 2), String(webkit.length), ...webkit, ...gpuix.flatMap(file => ['top:64', file])])
    strips.push(out)
  }
  strip('press', 'press', ['press-rest', 'press-down', 'press-up'])
  strip('pop', 'pop', ['pop'])
  strip('success', 'success', ['success'])
  strip('drop', 'drop', ['drop-in', 'drop-out'])
  writeFileSync(path.join(dir, 'README.txt'), `Top row: desktop motion CSS in WebKit; bottom row: GPUIX (render9-motion-lab.tsx), ${label}.\npress: rest, down 0/20/40/60/80 ms, up 0/50/100/150 ms\npop: 0/50/100/150/200/250 ms\nsuccess: 0/100/200/300/400/500 ms\ndrop: in 0/50/100/150/200 ms, out 0/50/100/150/200 ms\n`)
  console.log(`ok ${label}\n  ${strips.join('\n  ')}`)
}
process.exit(0)
