// P2.23 strip: a live turn settles while on screen at the tail; the work folds into "Worked for". Paused clock, one screenshot per offset.
//   bun native/ui-lease.ts gpuix-p2 bun scripts/motion-p2-fold.ts [--theme dark|light] [--reduced 0|1]
import '../src/native/local-build.ts'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../src/tasks/round7b-harness.ts'
const arg = (n: string, d: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1]! : d)
const theme = arg('--theme', 'dark'), reduced = arg('--reduced', '0')
const dir = path.join('/Users/mymac/projects/ade/previews/motion/gpuix-p2', `fold-${theme}-${reduced === '1' ? 'reduced' : 'normal'}`)
mkdirSync(dir, { recursive: true })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const f = await launchFixture(path.join(import.meta.dir, 'motion-p2-fold-lab.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: reduced, KYBERN_OPAQUE: '1', KYBERN_DATA_DIR: '/Users/mymac/projects/ade-gpuix-scratch/motion-gpuix-p2', KYBERN_CLIENT_CONFIG_DIR: '/Users/mymac/projects/ade-gpuix-scratch/motion-gpuix-p2-client', KYBERN_URL: '', KYBERN_TOKEN: '' })
const frames: string[] = []
try {
  const a = f.app; await a.getByTestId('fold-ready').waitFor()
  await a.call('focus', { elementId: (await a.getByTestId('fold-ready').element()).id }); await sleep(1500)
  await a.clock.pause()
  await a.call('keyDown', { key: 'c' }); await sleep(250)
  let now = 0
  for (const o of [0, 40, 80, 120, 160, 200, 260, 330, 450, 700]) { if (o > now) await a.clock.fastForward(o - now); now = o; await sleep(30); const file = path.join(dir, `fold-${String(o).padStart(3, '0')}.png`); await a.screenshot({ path: file }); frames.push(file) }
  await a.clock.resume()
} finally { await f.close() }
execFileSync('swift', [path.join(import.meta.dir, 'render9-grid.swift'), path.join(dir, 'fold-strip.png'), '0', '0', '2000', '1280', '5', ...frames.flatMap(file => ['top:0', file])])
console.log(`ok ${dir}`)
process.exit(0)
