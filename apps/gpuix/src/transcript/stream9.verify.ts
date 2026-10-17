// The live answer: a caret after the last text and per-word fade-in, drawn natively; frames are
// measured while it streams. Captures show the caret blink and the fading tail.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { launchFixture } from '../requests/harness.ts'
import { EVIDENCE, percentile } from './live.ts'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? `${EVIDENCE}/stream`
mkdirSync(out, { recursive: true })
const variants = process.env.STREAM_ONLY ? [process.env.STREAM_ONLY] : ['dark', 'light']
for (const theme of variants) for (const reduced of ['0', '1']) {
  const scratch = mkdtempSync(tmpdir() + '/gpuix-stream9-')
  const f = await launchFixture(import.meta.dir + '/stream.fixture.tsx', { GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: reduced, KYBERN_FRAME_TIMES: '1', KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch, KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_URL: '', KYBERN_TOKEN: '', ...(process.env.KYBERN_FULL_RATE ? { KYBERN_FULL_RATE: '1' } : {}) })
  try {
    await f.app.getByTestId('stream-ready').waitFor({ timeoutMs: 30000 })
    await Bun.sleep(3000)
    const tag = `${theme}${reduced === '1' ? '-reduced' : ''}`
    for (let i = 0; i < 8; i++) { await f.app.screenshot({ path: `${out}/stream-${tag}-${i}.png` }); await Bun.sleep(170) }
    // Frame intervals over six seconds of streaming (no screenshots inside the window).
    const before = f.frameTimes().length
    await Bun.sleep(6000)
    const stamps = f.frameTimes().slice(before)
    // `[kybern-frame]` reports a monotonic timestamp in ms: intervals are the differences.
    const frames = stamps.slice(1).map((value, i) => value - stamps[i]!)
    console.log(`${tag}: ${frames.length} frames in 6s, p50 ${percentile(frames, 0.5).toFixed(1)} ms, p95 ${percentile(frames, 0.95).toFixed(1)} ms, max ${Math.max(...frames).toFixed(1)} ms; KYBERN_FULL_RATE=${process.env.KYBERN_FULL_RATE ?? 'unset'}`)
  } finally { await f.close(); rmSync(scratch, { recursive: true, force: true }) }
}
process.exit(0)
