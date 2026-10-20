// Composer tray + attachment lightbox frame strips (V-strip, V-rm, V-kbd) and their cost (V-cost: island renders and React
// commits while each tween runs, `--cost 1`, no screenshots). scripts/composer-tray-lab.tsx under a paused automation clock,
// stepped to each offset, one window screenshot per frame, cropped into one strip per transition.
//   bun native/ui-lease.ts composer-tray bun scripts/composer-tray-strips.ts [--theme dark|light|both] [--reduced 0|1|both] [--cost 1]
import '../src/native/local-build.ts'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../src/tasks/round7b-harness.ts'
const arg = (name: string, fallback: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : fallback)
const themes = arg('--theme', 'both') === 'both' ? ['dark', 'light'] : [arg('--theme', 'dark')]
const reduceds = arg('--reduced', 'both') === 'both' ? ['0', '1'] : [arg('--reduced', '0')]
const cost = arg('--cost', '0') === '1'
const root = arg('--out', '/Users/mymac/projects/ade/previews/composer-tray/strips')
const scratch = { KYBERN_DATA_DIR: '/Users/mymac/projects/ade-gpuix-scratch/composer-tray/lab', KYBERN_CLIENT_CONFIG_DIR: '/Users/mymac/projects/ade-gpuix-scratch/composer-tray/lab-client', KYBERN_URL: '', KYBERN_TOKEN: '', NAPI_RS_NATIVE_LIBRARY_PATH: path.resolve(import.meta.dir, '../native/build/gpuix-native.darwin-arm64.node') }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
type Crop = { x: number; y: number; w: number; h: number }
const crops: Record<string, Crop> = { tray: { x: 40, y: 150, w: 736, h: 300 }, tiles: { x: 40, y: 500, w: 400, h: 120 }, lightbox: { x: 0, y: 0, w: 1180, h: 760 } }
for (const theme of themes) for (const reduced of reduceds) {
  const label = `${theme}-${reduced === '1' ? 'reduced' : 'normal'}`, dir = path.join(root, label)
  mkdirSync(dir, { recursive: true })
  const f = await launchFixture(path.join(import.meta.dir, 'composer-tray-lab.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: reduced, KYBERN_OPAQUE: '1', ...(cost ? { KYBERN_DEBUG_ISLANDS: '1' } : {}), ...scratch })
  const costs: string[] = []
  const sets: { name: string; strip: string; frames: string[]; commits: number[]; islands: number[] }[] = []
  try {
    const a = f.app; await a.getByTestId('app-ready').waitFor()
    const focus = async (id: string) => a.call('focus', { elementId: (await a.getByTestId(id).element()).id })
    await focus('app-ready')
    const commits = () => (f.diagnostics().match(/\[lab-commit\]/g) ?? []).length
    const shot = async (name: string) => { await sleep(30); const file = path.join(dir, `${name}.png`); await a.screenshot({ path: file }); return file }
    const key = async (k: string) => { await a.call('keyDown', { key: k }) }
    const click = async (id: string) => { const c = await a.getByTestId(id).center(); await a.mouse.move(c); await a.mouse.down(c); await a.mouse.up(c) }
    const off = { x: 1100, y: 40 }
    await sleep(800)
    await a.clock.pause()
    const run = async (id: string, strip: string, trigger: () => Promise<void>, offsets: number[], settle = 800) => {
      await trigger()
      if (cost) {
        const c0 = commits(), i0 = f.islandRenders()
        await a.clock.fastForward(Math.max(...offsets)); await sleep(60)
        costs.push(`${id}: ${f.islandRenders() - i0} island renders, ${commits() - c0} React commits over ${Math.max(...offsets)} ms`)
        await a.clock.fastForward(settle); return
      }
      const frames: string[] = [], seen: number[] = [], isl: number[] = []
      let at = 0
      for (const o of offsets) { if (o > at) await a.clock.fastForward(o - at); at = o; frames.push(await shot(`${id}-${String(o).padStart(3, '0')}`)); seen.push(commits()); isl.push(f.islandRenders()) }
      await a.clock.fastForward(settle)
      sets.push({ name: id, strip, frames, commits: seen, islands: isl })
    }
    // The tray opens and closes by pointer (Collapse + chevron); by keyboard it is instant.
    await run('tray-collapse', 'tray', async () => { await click('composer-tray-toggle'); await a.mouse.move(off) }, [0, 40, 80, 120, 160, 220, 300])
    await run('tray-expand', 'tray', async () => { await click('composer-tray-toggle'); await a.mouse.move(off) }, [0, 40, 80, 120, 160, 220, 300])
    await focus('composer-tray-toggle')
    await run('tray-kbd-collapse', 'tray', () => key('enter'), [0, 16])
    await run('tray-kbd-expand', 'tray', () => key('enter'), [0, 16])
    await focus('app-ready')
    // A subagent settles: loader → check cross-swap, row dims; the summary count swaps.
    await run('subagent-settle', 'tray', () => key('a'), [0, 40, 80, 125, 190, 250, 400])
    await run('subagent-resume', 'tray', () => key('a'), [0, 40, 80, 125, 190, 250, 400])
    // A subagent launches: its row rises in, the count swaps.
    await run('subagent-launch', 'tray', () => key('n'), [0, 40, 80, 125, 190, 250, 400])
    // A follow-up is queued, then sent: the row rises in, then lifts out and closes up.
    await run('queued-add', 'tray', () => key('y'), [0, 40, 80, 125, 190, 250, 400])
    await run('queued-sent', 'tray', () => key('q'), [0, 40, 80, 120, 160, 200, 300])
    // The attachment lightbox: pointer open zooms out of the tile; pointer close returns into it; Escape is instant.
    await run('lightbox-open', 'lightbox', () => click('attachment-image1'), [0, 40, 80, 120, 160, 220, 300, 400])
    await run('lightbox-close', 'lightbox', async () => { await click('attachment-lightbox-close'); await a.mouse.move(off) }, [0, 40, 80, 120, 160, 200, 300])
    await run('lightbox-reopen', 'lightbox', () => click('attachment-image1'), [0, 300])
    await run('lightbox-escape', 'lightbox', () => key('escape'), [0, 16])
    await run('lightbox-scrim-open', 'lightbox', () => click('attachment-image2'), [0, 300])
    await run('lightbox-scrim-close', 'lightbox', async () => { await a.mouse.move({ x: 20, y: 20 }); await a.mouse.down({ x: 20, y: 20 }); await a.mouse.up({ x: 20, y: 20 }) }, [0, 50, 100, 150, 200, 300])
    // The tile's × removes without opening.
    await run('tile-remove', 'tiles', () => click('remove-attachment-image2'), [0, 300])
    await a.clock.resume()
  } finally { await f.close() }
  if (cost) { writeFileSync(path.join(dir, 'COST.txt'), `Island renders and React commits across each tween, no screenshots, paused clock stepped once (${label}).\n${costs.join('\n')}\n`); console.log(`ok ${label}\n  ${costs.join('\n  ')}`); continue }
  const lines: string[] = []
  for (const s of sets) {
    const c = crops[s.strip]!, out = path.join(dir, `${s.name}--strip.png`)
    const cols = s.strip === 'lightbox' ? Math.min(4, s.frames.length) : s.frames.length <= 2 ? 2 : 4
    execFileSync('swift', [path.join(import.meta.dir, 'render9-grid.swift'), out, String(c.x * 2), String(c.y * 2), String(c.w * 2), String(c.h * 2), String(cols), ...s.frames.flatMap(file => ['top:0', file])])
    lines.push(`${s.name}: frames at ${s.frames.map(f => path.basename(f, '.png').split('-').pop()).join('/')} ms; React commits ${s.commits.join('/')}`)
  }
  writeFileSync(path.join(dir, 'README.txt'), `Composer tray lab, ${label}. Each strip is row-major, one frame per offset.\n${lines.join('\n')}\n`)
  console.log(`ok ${label}\n  ${lines.join('\n  ')}`)
}
process.exit(0)
