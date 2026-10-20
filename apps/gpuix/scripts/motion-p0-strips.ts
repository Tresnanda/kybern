// P0 motion strips (V-strip + V-cost + V-rm + V-kbd evidence): scripts/motion-p0-lab.tsx under a paused automation clock, stepped to
// each offset, one window screenshot per frame (visual strips only: never a timing run). Each item's frames are cropped into one
// horizontal strip; the number of React commits between its first and last tween frame is the V-cost line.
//   bun native/ui-lease.ts gpuix-p0 bun scripts/motion-p0-strips.ts [--theme dark|light|both] [--reduced 0|1|both]
import '../src/native/local-build.ts'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../src/tasks/round7b-harness.ts'
const arg = (name: string, fallback: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : fallback)
const themes = arg('--theme', 'both') === 'both' ? ['dark', 'light'] : [arg('--theme', 'dark')]
const reduceds = arg('--reduced', 'both') === 'both' ? ['0', '1'] : [arg('--reduced', '0')]
const root = arg('--out', '/Users/mymac/projects/ade/previews/motion/gpuix-p0')
const scratch = { KYBERN_DATA_DIR: '/Users/mymac/projects/ade-gpuix-scratch/motion-gpuix-p0', KYBERN_CLIENT_CONFIG_DIR: '/Users/mymac/projects/ade-gpuix-scratch/motion-gpuix-p0-client', KYBERN_URL: '', KYBERN_TOKEN: '' }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
type Crop = { x: number; y: number; w: number; h: number }
const crops: Record<string, Crop> = {
  rise: { x: 16, y: 16, w: 900, h: 84 }, 'swap-text': { x: 16, y: 124, w: 150, h: 32 }, 'swap-icon': { x: 200, y: 124, w: 40, h: 32 }, 'swap-copy': { x: 280, y: 124, w: 40, h: 32 },
  presence: { x: 16, y: 176, w: 220, h: 134 }, picker: { x: 290, y: 170, w: 250, h: 150 }, leaving: { x: 440, y: 170, w: 360, h: 120 }, kbd: { x: 550, y: 250, w: 320, h: 80 },
  chevrons: { x: 16, y: 340, w: 90, h: 32 }, meters: { x: 150, y: 340, w: 220, h: 80 }, arc: { x: 400, y: 340, w: 56, h: 56 },
  reveal: { x: 16, y: 430, w: 240, h: 32 }, hover: { x: 292, y: 422, w: 52, h: 52 }, 'press-row': { x: 356, y: 426, w: 208, h: 40 }, count: { x: 596, y: 426, w: 90, h: 40 },
}
const tween = [0, 40, 80, 120, 160, 250, 400]
for (const theme of themes) for (const reduced of reduceds) {
  const label = `${theme}-${reduced === '1' ? 'reduced' : 'normal'}`, dir = path.join(root, label)
  mkdirSync(dir, { recursive: true })
  const f = await launchFixture(path.join(import.meta.dir, 'motion-p0-lab.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: reduced, KYBERN_OPAQUE: '1', ...scratch })
  const sets: { name: string; strip: string; frames: string[]; commits: number[] }[] = []
  try {
    const a = f.app; await a.getByTestId('app-ready').waitFor()
    const ready = (await a.getByTestId('app-ready').element()).id
    await a.call('focus', { elementId: ready })
    const commits = () => (f.diagnostics().match(/\[lab-commit\]/g) ?? []).length
    // The automation screenshot (needs no Screen Recording permission) renders the view at the paused clock.
    const shot = async (name: string) => { await sleep(30); const file = path.join(dir, `${name}.png`); await a.screenshot({ path: file }); return file }
    const key = async (k: string) => { await a.call('keyDown', { key: k }) }
    await sleep(600)
    await a.clock.pause()
    /** Steps the clock to each offset, capturing a frame per offset; `strips` crops that set of frames per region. */
    const run = async (id: string, trigger: () => Promise<void>, offsets: number[], strips: string[], settle = 700) => {
      await trigger()
      const frames: string[] = [], seen: number[] = []
      let at = 0
      for (const o of offsets) { if (o > at) await a.clock.fastForward(o - at); at = o; frames.push(await shot(`${id}-${String(o).padStart(3, '0')}`)); seen.push(commits()) }
      await a.clock.fastForward(settle)
      for (const s of strips) sets.push({ name: id, strip: s, frames, commits: seen })
    }
    // Rise: the lab mounts plainly (rise 0), so the first press only arms it; the second plays every kind.
    await key('r'); await a.clock.fastForward(700)
    await run('rise', () => key('r'), [0, 40, 80, 120, 160, 250, 400, 600], ['rise'])
    await run('swap', () => key('s'), [0, 40, 80, 120, 160, 250, 400], ['swap-text', 'swap-icon'])
    await run('swap-back', () => key('s'), [0, 40, 80, 120, 160, 250, 400], ['swap-text', 'swap-icon'])
    await run('copy-check', () => key('c'), [0, 60, 120, 180, 250, 400], ['swap-copy'])
    await run('presence-exit', () => key('p'), [0, 40, 80, 120, 160, 250], ['presence'])
    await run('presence-enter', () => key('p'), [0, 40, 80, 120, 160, 250, 400], ['presence'])
    // Presence interrupted: hide, then show again at 60 ms (retargets from the value on screen).
    await key('p'); await a.clock.fastForward(60); const frames: string[] = [await shot('presence-interrupt-060')]; await key('p')
    for (const o of [20, 60, 120, 250]) { await a.clock.fastForward(o === 20 ? 20 : o - (o === 60 ? 20 : o === 120 ? 60 : 120)); frames.push(await shot(`presence-interrupt-${String(60 + o).padStart(3, '0')}`)) }
    sets.push({ name: 'presence-interrupt', strip: 'presence', frames, commits: [] }); await a.clock.fastForward(600)
    const trig = (await a.getByTestId('picker-trigger').center())
    await run('picker-open', async () => { await a.mouse.move(trig); await a.mouse.down(trig); await a.mouse.up(trig) }, [0, 40, 80, 160, 250, 400], ['picker'])
    await run('picker-close', async () => { await a.call('keyDown', { key: 'escape' }) }, [0, 100], ['picker'])
    await run('leaving-open', () => key('o'), [0, 40, 80, 160, 250, 400], ['leaving'])
    await run('leaving-exit', () => key('o'), [0, 30, 60, 90, 120, 160, 250], ['leaving'])
    await run('kbd-still-popup', () => key('q'), [0, 100], ['kbd'])
    await run('kbd-still-popup-close', () => key('q'), [0, 100], ['kbd'])
    await run('kbd-presence-exit', () => key('w'), [0, 100], ['kbd'])
    await run('kbd-presence-enter', () => key('w'), [0, 40, 125, 250], ['kbd'])
    await run('chevrons', () => key('k'), [0, 55, 110, 165, 220, 300], ['chevrons'])
    await run('chevrons-back', () => key('k'), [0, 55, 110, 165, 220, 300], ['chevrons'])
    await run('meter-fill', () => key('m'), [0, 100, 200, 300, 400, 500], ['meters'])
    await run('meter-shrink', async () => { await key('m'); await key('m') }, [0, 100, 200, 300, 400, 500], ['meters'])
    await run('arc', () => key('a'), [0, 100, 200, 300, 400, 500], ['arc'])
    await run('reveal-out', () => key('h'), [0, 30, 60, 100, 150, 250], ['reveal'])
    await run('reveal-in', () => key('h'), [0, 30, 60, 100, 150, 250], ['reveal'])
    const btn = await a.getByTestId('hover-btn').center(), away = { x: btn.x, y: btn.y + 120 }
    await run('hover-scale', async () => { await a.mouse.move(btn) }, [0, 40, 80, 150, 250], ['hover'])
    await run('hover-press', async () => { await a.mouse.down(btn) }, [0, 40, 80, 150], ['hover'])
    await run('hover-release', async () => { await a.mouse.up(btn) }, [0, 40, 80, 150, 250], ['hover'])
    await run('hover-out', async () => { await a.mouse.move(away) }, [0, 40, 80, 150, 250], ['hover'])
    const row = await a.getByTestId('press-row').center()
    await run('press-row', async () => { await a.mouse.move(row); await a.mouse.down(row) }, [0, 200], ['press-row'])
    await run('press-row-up', async () => { await a.mouse.up(row); await a.mouse.move(away) }, [0, 200], ['press-row'])
    await run('count-pop', () => key('n'), [0, 60, 125, 190, 250, 400], ['count'])
    await a.clock.resume()
  } finally { await f.close() }
  const lines: string[] = []
  for (const s of sets) {
    const c = crops[s.strip]!, out = path.join(dir, `${s.name}--${s.strip}-strip.png`)
    execFileSync('swift', [path.join(import.meta.dir, 'render9-grid.swift'), out, String(c.x * 2), String(c.y * 2), String(c.w * 2), String(c.h * 2), String(Math.min(s.frames.length, s.strip === 'rise' ? 4 : 8)), ...s.frames.flatMap(file => ['top:0', file])])
    lines.push(`${s.name} (${s.strip}): commits at frames ${s.commits.join('/')}`)
  }
  writeFileSync(path.join(dir, 'README.txt'), `GPUIX motion P0 lab, ${label}.\n${lines.join('\n')}\n`)
  console.log(`ok ${label}\n  ${lines.join('\n  ')}`)
}
process.exit(0)
