// P3 motion strips (V-strip + V-cost + V-rm + V-kbd evidence): scripts/motion-p3-lab.tsx under a paused automation clock, stepped
// to each offset, one window screenshot per frame (visual strips only: never a timing run). Each item's frames are cropped into one
// horizontal strip; the React commits seen at each frame are the V-cost line (`--cost 1` runs the same tweens without screenshots).
//   NAPI_RS_NATIVE_LIBRARY_PATH=$PWD/native/build/gpuix-native.darwin-arm64.node \
//   bun native/ui-lease.ts gpuix-p3 bun scripts/motion-p3-strips.ts [--theme dark|light|both] [--reduced 0|1|both] [--only a,b] [--cost 1]
import '../src/native/local-build.ts'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../src/tasks/round7b-harness.ts'
const arg = (name: string, fallback: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : fallback)
const themes = arg('--theme', 'both') === 'both' ? ['dark', 'light'] : [arg('--theme', 'dark')]
const reduceds = arg('--reduced', 'both') === 'both' ? ['0', '1'] : [arg('--reduced', '0')]
const only = arg('--only', '').split(',').filter(Boolean)
const cost = arg('--cost', '0') === '1'
const root = arg('--out', '/Users/mymac/projects/ade/previews/motion/gpuix-p3')
const scratch = { KYBERN_DATA_DIR: '/Users/mymac/projects/ade-gpuix-scratch/motion-gpuix-p3', KYBERN_CLIENT_CONFIG_DIR: '/Users/mymac/projects/ade-gpuix-scratch/motion-gpuix-p3-client', KYBERN_URL: '', KYBERN_TOKEN: '' }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
type Crop = { x: number; y: number; w: number; h: number }
const crops: Record<string, Crop> = {
  menu: { x: 0, y: 0, w: 260, h: 240 }, ctx: { x: 300, y: 40, w: 240, h: 130 }, tips: { x: 520, y: 0, w: 240, h: 100 }, dialog: { x: 200, y: 170, w: 560, h: 260 },
  alert: { x: 200, y: 170, w: 560, h: 260 }, sheet: { x: 560, y: 0, w: 400, h: 300 }, select: { x: 0, y: 250, w: 260, h: 170 }, hover: { x: 290, y: 250, w: 240, h: 150 },
  segmented: { x: 8, y: 336, w: 220, h: 40 }, switch: { x: 240, y: 340, w: 60, h: 36 }, badge: { x: 330, y: 340, w: 130, h: 36 }, empty: { x: 560, y: 100, w: 260, h: 220 },
  loading: { x: 8, y: 416, w: 380, h: 130 }, full: { x: 0, y: 0, w: 960, h: 600 },
}
for (const theme of themes) for (const reduced of reduceds) {
  const label = `${theme}-${reduced === '1' ? 'reduced' : 'normal'}`, dir = path.join(root, label)
  mkdirSync(dir, { recursive: true })
  const f = await launchFixture(path.join(import.meta.dir, 'motion-p3-lab.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: reduced, KYBERN_OPAQUE: '1', KYBERN_DEBUG_ISLANDS: '1', ...scratch })
  const costs: string[] = []
  const sets: { name: string; strip: string; frames: string[]; commits: number[] }[] = []
  try {
    const a = f.app; await a.getByTestId('app-ready').waitFor()
    await a.call('focus', { elementId: (await a.getByTestId('app-ready').element()).id })
    const commits = () => (f.diagnostics().match(/\[lab-commit\]/g) ?? []).length
    const shot = async (name: string) => { await sleep(30); const file = path.join(dir, `${name}.png`); await a.screenshot({ path: file }); return file }
    const ready = (await a.getByTestId('app-ready').element()).id
    // Lab shortcuts go to the lab root; a popup that took focus (a menu, a dialog) and then unmounted leaves none, so refocus first.
    // `escape` and `enter` are meant for whatever popup holds focus.
    const key = async (k: string) => { if (k !== 'escape' && k !== 'enter') await a.call('focus', { elementId: ready }); await a.call('keyDown', { key: k }) }
    const center = async (id: string) => { try { return await a.getByTestId(id).center() } catch (error) { const ids = (await a.getByType('div').all()).filter(n => n.testId).map(n => n.testId).join(' '); throw new Error(`no element ${id}: ${error}; present: ${ids}`) } }
    const click = async (id: string) => { const c = await center(id); await a.mouse.move(c); await a.mouse.down(c); await a.mouse.up(c) }
    const off = { x: 930, y: 580 }
    await sleep(800)
    await a.clock.pause()
    /** `real` is wall-clock time for things on real timers (a hover delay) before the stepped frames start. */
    const run = async (id: string, strip: string, trigger: () => Promise<void>, offsets: number[], settle = 800, real = 0) => {
      if (only.length && !only.some(o => id.startsWith(o))) { await trigger(); await sleep(real); await a.clock.fastForward(settle); return }
      await trigger(); await sleep(real)
      if (cost) {
        const c0 = commits(), i0 = f.islandRenders()
        await a.clock.fastForward(Math.max(...offsets)); await sleep(60)
        costs.push(`${id}: ${commits() - c0} React commits, ${f.islandRenders() - i0} island renders over ${Math.max(...offsets)} ms`)
        await a.clock.fastForward(settle); return
      }
      const frames: string[] = [], seen: number[] = []
      let at = 0
      for (const o of offsets) { if (o > at) await a.clock.fastForward(o - at); at = o; frames.push(await shot(`${id}-${String(o).padStart(3, '0')}`)); seen.push(commits()) }
      await a.clock.fastForward(settle)
      sets.push({ name: id, strip, frames, commits: seen })
    }
    const T = [0, 40, 80, 120, 160, 250, 400]
    // P3.12: menus, pointer open, pointer pick (exit), Escape (instant), and an outside press with a submenu open (both leave together)
    await run('menu-open', 'menu', () => click('menu-main'), T)
    await run('menu-pick', 'menu', () => click('menu-item-one'), [0, 40, 80, 120, 160, 250])
    await run('menu-reopen', 'menu', () => click('menu-main'), [0, 200])
    await run('menu-escape', 'menu', () => key('escape'), [0, 40, 100])
    await click('menu-main'); await a.clock.fastForward(500)
    const sub = await center('menu-sub'); await a.mouse.move(sub); await a.clock.fastForward(600)
    await run('menu-sub-open-outside-close', 'menu', async () => { await a.mouse.move(off); await a.mouse.down(off); await a.mouse.up(off) }, [0, 40, 80, 120, 160, 250])
    await run('ctx-open', 'ctx', () => key('x'), T)
    await run('ctx-pick', 'ctx', () => click('ctx-item'), [0, 40, 80, 120, 160, 250])
    await key('x'); await a.clock.fastForward(500)
    await run('ctx-escape', 'ctx', () => key('escape'), [0, 40, 100])
    // P3.13: tooltips. The hover delay (600 ms) runs on a real timer; the paused clock then steps the 150 ms scale-in; a neighbour opens at once.
    const tipA = await center('tip-a'), tipB = await center('tip-b')
    await run('tip-open', 'tips', () => a.mouse.move(tipA), [0, 40, 80, 120, 160, 250, 400], 800, 800)
    await run('tip-chain-a-to-b', 'tips', () => a.mouse.move(tipB), [0, 40, 80, 120, 200, 300])
    await run('tip-close', 'tips', () => a.mouse.move(off), [0, 40, 80, 120, 200])
    // P3.14: dialog by pointer (scrim + card), close by X (exit), close by outside press, Escape (instant), shortcut-opened (instant both ways)
    await run('dialog-open', 'dialog', () => key('d'), T)
    await run('dialog-close-x', 'dialog', () => click('dialog-close'), [0, 40, 80, 120, 160, 250])
    await run('dialog-reopen', 'dialog', () => key('d'), [0, 300])
    await run('dialog-close-cancel', 'dialog', () => click('dialog-cancel'), [0, 40, 80, 120, 160, 250])
    await key('d'); await a.clock.fastForward(500)
    await run('dialog-close-outside', 'dialog', async () => { await a.mouse.move({ x: 60, y: 560 }); await a.mouse.down({ x: 60, y: 560 }); await a.mouse.up({ x: 60, y: 560 }) }, [0, 40, 80, 120, 160, 250])
    await key('d'); await a.clock.fastForward(500)
    await run('dialog-kbd-escape', 'dialog', () => key('escape'), [0, 40, 100])
    await run('dialog-kbd-open', 'dialog', () => key('k'), [0, 40, 100])
    await run('dialog-kbd-close', 'dialog', () => key('escape'), [0, 40, 100])
    // P3.16: alert dialog, scale .98 in and out
    await run('alert-open', 'alert', () => key('a'), T)
    await run('alert-close', 'alert', () => click('alert-cancel'), [0, 40, 80, 120, 160, 250])
    // Sheet (shares the kit's ModalLayer)
    await run('sheet-open', 'sheet', () => key('s'), T)
    await run('sheet-close', 'sheet', () => key('escape'), [0, 40, 80, 120, 160, 250])
    // P3.18: select, pointer open / pick (exit), keyboard open (instant)
    await run('select-open', 'select', () => click('sel-trigger'), [0, 40, 80, 120, 160, 250])
    await run('select-pick', 'select', () => click('sel-option-c'), [0, 30, 60, 90, 130, 250])
    await a.call('focus', { elementId: (await a.getByTestId('sel-trigger').element()).id })
    await run('select-kbd-open', 'select', () => key('enter'), [0, 40, 100])
    await run('select-kbd-close', 'select', () => key('escape'), [0, 40, 100])
    // P3.17: hover card (delay 100 ms, close 50 ms)
    const hc = await center('hover-trigger')
    await run('hovercard-open', 'hover', () => a.mouse.move(hc), [0, 40, 80, 120, 160, 250, 400], 800, 450)
    await run('hovercard-close', 'hover', () => a.mouse.move(off), [0, 40, 80, 120, 200, 300])
    // P3.19 / P3.20 / P3.6 / P3.7
    await run('segmented', 'segmented', () => key('g'), [0, 40, 80, 120, 160, 250, 400])
    await run('switch-on', 'switch', () => key('v'), [0, 40, 80, 120, 160, 200, 300])
    await run('switch-off', 'switch', () => key('v'), [0, 40, 80, 120, 160, 200, 300])
    await run('badge-count', 'badge', () => key('n'), [0, 60, 125, 190, 250, 400])
    await run('empty-stagger', 'empty', () => key('e'), [0, 70, 140, 210, 300, 500, 800])
    await run('loading-after-delay', 'loading', () => key('l'), [0, 100, 150, 200, 300, 450, 700])
    await a.clock.resume()
  } finally { await f.close() }
  if (cost) { writeFileSync(path.join(dir, 'COST.txt'), `React commits and island renders across each tween, no screenshots, paused clock stepped once (${label}).\n${costs.join('\n')}\n`); console.log(`ok ${label}\n  ${costs.join('\n  ')}`); continue }
  const lines: string[] = []
  for (const s of sets) {
    const c = crops[s.strip]!, out = path.join(dir, `${s.name}--${s.strip}-strip.png`)
    execFileSync('swift', [path.join(import.meta.dir, 'render9-grid.swift'), out, String(c.x * 2), String(c.y * 2), String(c.w * 2), String(c.h * 2), String(Math.min(s.frames.length, c.w > 400 ? 4 : c.w > 200 ? 5 : 7)), ...s.frames.flatMap(file => ['top:0', file])])
    lines.push(`${s.name} (${s.strip}): React commits at frames ${s.commits.join('/')}`)
  }
  writeFileSync(path.join(dir, 'README.txt'), `GPUIX motion P3 lab, ${label}.\n${lines.join('\n')}\n`)
  console.log(`ok ${label}\n  ${lines.join('\n  ')}`)
}
process.exit(0)
