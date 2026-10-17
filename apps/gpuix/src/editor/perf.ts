// Typing latency in a 2,000-word note and idle frames, for the shared editor.
//
// Latency: from sending a key to the first frame whose painted text contains it,
// observed through the automation bridge (so it includes that round trip; the
// desktop reference in perf-desktop.mjs is measured the same way through
// Playwright). Idle: frames painted in 3 s with the editor blurred (expect 0) and
// focused (only the caret blink). KYBERN_FULL_RATE is not set.
//
//   bun src/editor/perf.ts
import '../native/local-build.ts'
import path from 'node:path'
import { launchFixture } from '../requests/harness.ts'
import { SAMPLES } from './samples.ts'

const scratch = process.env.KYBERN_EDITOR_SCRATCH ?? '/Users/mymac/projects/ade-gpuix-scratch/phase2-editor9'
const words = SAMPLES.long!.split(/\s+/).filter(Boolean).length
const f = await launchFixture(path.join(import.meta.dir, 'lab.tsx'), { KYBERN_APPEARANCE: 'dark', GPUIX_BACKGROUND: '1', KYBERN_EDITOR_SAMPLE: 'long', KYBERN_FRAME_TIMES: '1', KYBERN_DATA_DIR: `${scratch}/lab-data`, KYBERN_CLIENT_CONFIG_DIR: `${scratch}/lab-client`, KYBERN_URL: '' })
const a = f.app
const editor = a.getByTestId('editor')
const painted = async () => (await a.call('getPaintedText', {})).text.join('\n')
const pct = (xs: number[], p: number) => { const s = [...xs].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]! }
try {
  await editor.waitFor()
  await Bun.sleep(1500)
  // Idle, blurred.
  await a.getByTestId('lab-blur').click(); await Bun.sleep(1000)
  let start = f.frameTimes().length
  await Bun.sleep(3000)
  const idleBlurred = f.frameTimes().length - start
  // Typing at the end of the note.
  await a.getByTestId('lab-focus-end').click(); await Bun.sleep(300)
  await editor.press('space')
  const samples: number[] = []
  let typed = ' '
  for (let i = 0; i < 70; i++) {
    const ch = 'abcdefghij'[i % 10]!
    typed += ch
    const t0 = performance.now()
    await editor.press(ch)
    while (!(await painted()).includes(`.${typed}`)) await Bun.sleep(1)
    if (i >= 10) samples.push(performance.now() - t0)
    await Bun.sleep(80)
  }
  await a.getByTestId('lab-stats').click()
  // Idle, focused: the caret blink only.
  await Bun.sleep(1000)
  start = f.frameTimes().length
  await Bun.sleep(3000)
  const idleFocused = f.frameTimes().length - start
  console.log(JSON.stringify({ words, keys: samples.length, p50: +pct(samples, 0.5).toFixed(1), p95: +pct(samples, 0.95).toFixed(1), max: +Math.max(...samples).toFixed(1), idleBlurredFrames3s: idleBlurred, idleFocusedFrames3s: idleFocused, fullRate: !!process.env.KYBERN_FULL_RATE }))
} catch (error) { console.error(f.diagnostics()); throw error } finally { await f.close() }
