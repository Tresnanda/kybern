// Frame intervals of the editor's one animation, the checklist tick (150 ms fill and
// scale, 80 ms fade), measured from the native frame log. KYBERN_FULL_RATE is not set.
//
//   bun src/editor/motion.ts            (KYBERN_REDUCED_MOTION=1 checks that it is instant)
import '../native/local-build.ts'
import path from 'node:path'
import { launchFixture } from '../requests/harness.ts'

const scratch = process.env.KYBERN_EDITOR_SCRATCH ?? '/Users/mymac/projects/ade-gpuix-scratch/phase2-editor9'
const reduced = process.env.KYBERN_REDUCED_MOTION ?? '0'
const f = await launchFixture(path.join(import.meta.dir, 'lab.tsx'), { KYBERN_APPEARANCE: 'dark', KYBERN_REDUCED_MOTION: reduced, GPUIX_BACKGROUND: '1', KYBERN_FRAME_TIMES: '1', KYBERN_DATA_DIR: `${scratch}/lab-data`, KYBERN_CLIENT_CONFIG_DIR: `${scratch}/lab-client`, KYBERN_URL: '' })
const a = f.app
const pct = (xs: number[], p: number) => { const s = [...xs].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0 }
try {
  await a.getByTestId('editor').waitFor(); await Bun.sleep(800)
  await a.getByTestId('lab-publish').click(); await Bun.sleep(200)
  const debug = JSON.parse(await a.getByTestId('editor-debug').textContent()) as { layout: { x: number; y: number; blocks: { ty: number; listX: number; lineHeight: number }[] } }
  const first = debug.layout.blocks[3]! // "Write the migration notes"
  const intervals: number[] = []
  let frames = 0
  for (let i = 0; i < 6; i++) {
    await Bun.sleep(400)
    const before = f.frameTimes().length
    await a.mouse.click({ x: debug.layout.x + first.listX + 8, y: debug.layout.y + first.ty + first.lineHeight / 2 })
    await Bun.sleep(400)
    const times = f.frameTimes().slice(before)
    frames += times.length
    for (let j = 1; j < times.length; j++) intervals.push(times[j]! - times[j - 1]!)
  }
  console.log(JSON.stringify({ animation: 'checklist tick', reducedMotion: reduced === '1', toggles: 6, framesPerToggle: +(frames / 6).toFixed(1), p50: +pct(intervals, 0.5).toFixed(1), p95: +pct(intervals, 0.95).toFixed(1), fullRate: !!process.env.KYBERN_FULL_RATE }))
} catch (error) { console.error(f.diagnostics()); throw error } finally { await f.close() }
