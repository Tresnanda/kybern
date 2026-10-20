// P2 motion strips (V-strip + V-cost + V-rm + V-kbd evidence): scripts/motion-p2-lab.tsx under a paused automation clock, stepped to
// each offset, one window screenshot per frame (visual strips only: never a timing run). Each item's frames are cropped into one
// horizontal strip; the number of React commits seen at each frame is the V-cost line.
//   bun native/ui-lease.ts gpuix-p2 bun scripts/motion-p2-strips.ts [--theme dark|light|both] [--reduced 0|1|both] [--only a,b]
import '../src/native/local-build.ts'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../src/tasks/round7b-harness.ts'
const arg = (name: string, fallback: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : fallback)
const themes = arg('--theme', 'both') === 'both' ? ['dark', 'light'] : [arg('--theme', 'dark')]
const reduceds = arg('--reduced', 'both') === 'both' ? ['0', '1'] : [arg('--reduced', '0')]
const only = arg('--only', '').split(',').filter(Boolean)
const root = arg('--out', '/Users/mymac/projects/ade/previews/motion/gpuix-p2')
const scratch = { KYBERN_DATA_DIR: '/Users/mymac/projects/ade-gpuix-scratch/motion-gpuix-p2', KYBERN_CLIENT_CONFIG_DIR: '/Users/mymac/projects/ade-gpuix-scratch/motion-gpuix-p2-client', KYBERN_URL: '', KYBERN_TOKEN: '' }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
type Crop = { x: number; y: number; w: number; h: number }
const crops: Record<string, Crop> = {
  send: { x: 10, y: 8, w: 72, h: 60 }, attachments: { x: 90, y: 16, w: 460, h: 100 }, queued: { x: 560, y: 10, w: 560, h: 150 }, tray: { x: 10, y: 132, w: 120, h: 48 },
  slider: { x: 240, y: 130, w: 300, h: 70 }, dim: { x: 560, y: 170, w: 260, h: 56 }, scroll: { x: 16, y: 230, w: 300, h: 170 }, image: { x: 340, y: 230, w: 320, h: 180 },
  panel: { x: 690, y: 240, w: 430, h: 160 }, button: { x: 10, y: 424, w: 176, h: 44 }, disclosure: { x: 200, y: 424, w: 320, h: 120 }, subagent: { x: 16, y: 570, w: 700, h: 56 }, live: { x: 700, y: 430, w: 440, h: 300 },
}
for (const theme of themes) for (const reduced of reduceds) {
  const label = `${theme}-${reduced === '1' ? 'reduced' : 'normal'}`, dir = path.join(root, label)
  mkdirSync(dir, { recursive: true })
  const f = await launchFixture(path.join(import.meta.dir, 'motion-p2-lab.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: reduced, KYBERN_OPAQUE: '1', ...scratch })
  const sets: { name: string; strip: string; frames: string[]; commits: number[] }[] = []
  try {
    const a = f.app; await a.getByTestId('app-ready').waitFor()
    await a.call('focus', { elementId: (await a.getByTestId('app-ready').element()).id })
    const commits = () => (f.diagnostics().match(/\[lab-commit\]/g) ?? []).length
    const shot = async (name: string) => { await sleep(30); const file = path.join(dir, `${name}.png`); await a.screenshot({ path: file }); return file }
    const key = async (k: string) => { await a.call('keyDown', { key: k }) }
    const center = async (id: string) => a.getByTestId(id).center()
    await sleep(800)
    await a.clock.pause()
    const run = async (id: string, strip: string, trigger: () => Promise<void>, offsets: number[], settle = 800) => {
      if (only.length && !only.some(o => id.startsWith(o))) { await trigger(); await a.clock.fastForward(settle); return }
      await trigger()
      const frames: string[] = [], seen: number[] = []
      let at = 0
      for (const o of offsets) { if (o > at) await a.clock.fastForward(o - at); at = o; frames.push(await shot(`${id}-${String(o).padStart(3, '0')}`)); seen.push(commits()) }
      await a.clock.fastForward(settle)
      sets.push({ name: id, strip, frames, commits: seen })
    }
    const off = { x: 1000, y: 700 }
    // P2.1 / P2.2: send button
    const send = await center('send')
    await run('send-hover-in', 'send', () => a.mouse.move(send), [0, 40, 80, 150, 250])
    await run('send-press', 'send', () => a.mouse.down(send), [0, 40, 80, 150])
    await run('send-release', 'send', () => a.mouse.up(send), [0, 40, 80, 150, 250])
    await run('send-hover-out', 'send', () => a.mouse.move(off), [0, 40, 80, 150, 250])
    await run('send-to-sending', 'send', () => key('e'), [0, 60, 125, 190, 250, 400])
    await run('sending-to-send', 'send', () => key('e'), [0, 60, 125, 190, 250, 400])
    await run('send-to-stop', 'send', () => key('u'), [0, 60, 125, 190, 250, 400])
    await run('stop-to-send', 'send', () => key('u'), [0, 60, 125, 190, 250, 400])
    // P2.3: tray chip press
    const chip = await center('tray-chip')
    await run('tray-press', 'tray', async () => { await a.mouse.move(chip); await a.mouse.down(chip) }, [0, 40, 80, 150])
    await run('tray-release', 'tray', async () => { await a.mouse.up(chip); await a.mouse.move(off) }, [0, 40, 80, 150, 250])
    // P2.4: attachment add / remove by pointer
    await run('attachment-add', 'attachments', () => key('z'), [0, 60, 125, 190, 250, 400])
    const remove = await center('remove-attachment-image1')
    await run('attachment-remove', 'attachments', async () => { await a.mouse.move(remove); await a.mouse.down(remove); await a.mouse.up(remove); await a.mouse.move(off) }, [0, 30, 60, 100, 150, 250])
    // P2.5: queued rows
    await run('queued-add', 'queued', () => key('y'), [0, 60, 125, 190, 250, 400])
    await run('queued-remove-row', 'queued', () => key('q'), [0, 50, 100, 150, 200, 300])
    await run('queued-clear-panel', 'queued', () => key('w'), [0, 50, 100, 150, 200, 300])
    await run('queued-add-first', 'queued', () => key('y'), [0, 60, 125, 190, 250, 400])
    // P2.6: effort slider press, drag, release
    const track = await a.getByTestId('effort-slider').bounds()
    const thumb = { x: track.x + 12 + (track.width - 24) * 0.25, y: track.y + 14 }, to = { x: track.x + 12 + (track.width - 24) * 0.75, y: track.y + 14 }
    await run('slider-press', 'slider', async () => { await a.mouse.move(thumb); await a.mouse.down(thumb) }, [0, 60, 120, 200, 300])
    await run('slider-drag', 'slider', async () => { await a.mouse.move({ x: (thumb.x + to.x) / 2, y: thumb.y }); await a.mouse.move(to) }, [0, 40, 80, 150])
    await run('slider-release', 'slider', () => a.mouse.up(to), [0, 60, 120, 200, 300, 450, 600])
    await a.mouse.move(off)
    // P2.7: busy dim
    await run('dim-on', 'dim', () => key('d'), [0, 50, 100, 150, 250])
    await run('dim-off', 'dim', () => key('d'), [0, 50, 100, 150, 250])
    // P2.10 / P2.22: jump to latest + bottom fade
    await run('scroll-in', 'scroll', () => key('b'), [0, 40, 80, 125, 190, 250, 400])
    await run('scroll-out', 'scroll', () => key('b'), [0, 40, 80, 125, 150, 250])
    // P2.12: image reveal
    await run('image-reveal', 'image', () => key('i'), [0, 100, 200, 300, 400, 500])
    // P2.13: request card, pointer and keyboard
    await run('panel-exit', 'panel', () => key('p'), [0, 40, 80, 125, 190])
    await run('panel-enter', 'panel', () => key('p'), [0, 40, 80, 125, 180, 300])
    await run('panel-kbd-exit', 'panel', () => key('o'), [0, 100])
    await run('panel-kbd-enter', 'panel', () => key('o'), [0, 100])
    // P2.14: submit label
    await run('label-swap', 'button', () => key('l'), [0, 60, 125, 190, 250, 400])
    // P2.8: transcript chevron + collapse
    await run('chevron-open', 'disclosure', () => key('k'), [0, 55, 110, 165, 220, 300])
    await run('chevron-close', 'disclosure', () => key('k'), [0, 55, 110, 165, 220, 300])
    // P2.15: subagent status
    await run('subagent-done', 'subagent', () => key('a'), [0, 60, 125, 190, 250, 400])
    await run('subagent-working', 'subagent', () => key('a'), [0, 60, 125, 190, 250, 400])
    // P2.20 / P2.21: live view
    await run('live-controls-in', 'live', () => key('h'), [0, 50, 100, 150, 200, 300])
    await run('live-controls-out', 'live', () => key('h'), [0, 40, 80, 120, 200])
    await run('live-ripple', 'live', () => key('r'), [0, 100, 200, 300, 400, 500])
    await run('live-leave', 'live', () => key('f'), [0, 40, 80, 120, 160, 250])
    await a.clock.resume()
  } finally { await f.close() }
  const lines: string[] = []
  for (const s of sets) {
    const c = crops[s.strip]!, out = path.join(dir, `${s.name}--${s.strip}-strip.png`)
    execFileSync('swift', [path.join(import.meta.dir, 'render9-grid.swift'), out, String(c.x * 2), String(c.y * 2), String(c.w * 2), String(c.h * 2), String(Math.min(s.frames.length, s.strip === 'queued' || s.strip === 'attachments' || s.strip === 'live' || s.strip === 'subagent' ? 3 : 4)), ...s.frames.flatMap(file => ['top:0', file])])
    lines.push(`${s.name} (${s.strip}): commits at frames ${s.commits.join('/')}`)
  }
  writeFileSync(path.join(dir, 'README.txt'), `GPUIX motion P2 lab, ${label}.\n${lines.join('\n')}\n`)
  console.log(`ok ${label}\n  ${lines.join('\n  ')}`)
}
process.exit(0)
