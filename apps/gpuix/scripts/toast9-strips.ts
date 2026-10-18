// Toast cross-fade strips (visual only: the automation clock is paused and stepped, never a timing run).
//   bun scripts/toast9-strips.ts [--theme dark|light|both] [--reduced 0|1|both]
import '../src/native/local-build.ts'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../src/tasks/round7b-harness.ts'
const arg = (name: string, fallback: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : fallback)
const themes = arg('--theme', 'both') === 'both' ? ['dark', 'light'] : [arg('--theme', 'dark')]
const reduceds = arg('--reduced', 'both') === 'both' ? ['0', '1'] : [arg('--reduced', '0')]
const root = '/Users/mymac/projects/ade/previews/gpuix/phase2/toast9/strips'
const scratch = { KYBERN_DATA_DIR: '/Users/mymac/projects/ade-gpuix-scratch/toast9', KYBERN_CLIENT_CONFIG_DIR: '/Users/mymac/projects/ade-gpuix-scratch/toast9-client', KYBERN_URL: '', KYBERN_TOKEN: '' }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
for (const theme of themes) for (const reduced of reduceds) {
  const label = `${theme}-${reduced === '1' ? 'reduced' : 'normal'}`, dir = path.join(root, label)
  mkdirSync(dir, { recursive: true })
  const f = await launchFixture(path.join(import.meta.dir, 'toast9-lab.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: reduced, KYBERN_OPAQUE: '1', TOAST9_HOLD: '1', ...scratch })
  const frames: Record<string, string[]> = {}
  try {
    const a = f.app; await a.getByTestId('app-ready').waitFor()
    const rootId = (await a.getByTestId('app-ready').element()).id
    await a.call('focus', { elementId: rootId })
    const windowId = execFileSync('swift', [path.join(import.meta.dir, '../src/tasks/round7-window-id.swift'), String(f.pid)], { encoding: 'utf8' }).trim()
    const shot = async (prefix: string, name: string) => { await sleep(120); const file = path.join(dir, `${prefix}-${name}.png`); execFileSync('screencapture', ['-x', '-o', '-l', windowId, file]); (frames[prefix] ??= []).push(file) }
    const key = async (k: string) => { await a.call('keyDown', { key: k }) }
    await sleep(600)
    await a.clock.pause()
    const steps = async (offsets: number[], prefix: string) => {
      let at = 0
      for (const o of offsets) { if (o > at) await a.clock.fastForward(o - at); at = o; await shot(prefix, String(o).padStart(3, '0')) }
      await a.clock.fastForward(600)
    }
    const enter = [0, 30, 60, 90, 120, 160, 200, 250]
    await key('a'); await steps(enter, 'enter')
    await key('x'); await steps([0, 30, 60, 90, 120, 160], 'exit-single')
    await key('a'); await a.clock.fastForward(400)
    await key('b'); await steps(enter, 'stack')         // second toast arrives (collapsed stack: card -> ghost, newcomer fades in)
    await key('c'); await steps(enter, 'stack3')
    await key('r'); await steps([0, 30, 60, 90, 120, 160, 200, 250], 'replace')   // 'a' is a ghost behind: in-place update
    await key('x'); await steps([0, 30, 60, 90, 120, 160], 'exit')
    await key('a'); await a.clock.fastForward(400)
    await key('r'); await steps([0, 30, 60, 90, 120, 160, 200, 250], 'replace-front') // front card replaced by new text
    await key('x'); await a.clock.fastForward(400)
    await key('1'); await steps(enter, 'error')
    await key('x'); await a.clock.fastForward(400)
    await a.clock.resume()
  } finally { await f.close() }
  for (const [name, files] of Object.entries(frames)) {
    const out = path.join(dir, `${name}-strip.png`)
    // Bottom-right of the 520x300 window at 2x; skip the 32 pt title bar.
    execFileSync('swift', [path.join(import.meta.dir, 'render9-grid.swift'), out, String(2 * 100), String(2 * 150), String(2 * 420), String(2 * 150), '4', ...files.flatMap(file => ['top:64', file])])
  }
  console.log('ok', label, Object.keys(frames).join(' '))
}
process.exit(0)
