// A long live reply: pieces outside the visible part are spacers (`BoundedMarkdown` in markdown.tsx). Streams a reply of
// paragraphs, tables and code at 25 deltas/s with every piece mounted (`KYBERN_REPLY_CULL=0`) and culled, and reports
// frame intervals, native layout per frame and footprint while it grows; then, once it stops, both must paint
// identically at the top of the transcript and a fixed scroll below it.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { launchFixture } from '../requests/harness.ts'
import { lease } from '../../perf/bench/lease.ts'
import { pixels } from '../../native/png.ts'
import { EVIDENCE, percentile } from './live.ts'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? `${EVIDENCE}/reply-cull`
mkdirSync(out, { recursive: true })
const themes = process.env.CULL_THEMES?.split(',') ?? ['dark', 'light']
const modes = process.env.CULL_MODES?.split(',') ?? ['inline', 'culled']
const STOP = Number(process.env.CULL_STOP ?? 700)
const footprint = (pid: number) => Number(/phys_footprint:\s*([\d.]+)\s*MB/.exec(execFileSync('footprint', ['-p', String(pid)], { encoding: 'utf8' }))?.[1] ?? NaN)
const release = await lease()
const shots: Record<string, string> = {}
let failed = false
try {
  for (const theme of themes) for (const mode of modes) {
    const scratch = mkdtempSync(tmpdir() + '/gpuix-cull-')
    // Per-frame native cost (`[kybern-work]`), counted inside the measured window only.
    let window = false, layout: number[] = [], rest = ''
    const f = await launchFixture(import.meta.dir + '/stream.fixture.tsx', { KYBERN_FRAME_COSTS: '1', KYBERN_REPLY_OVERSCAN: process.env.KYBERN_REPLY_OVERSCAN ?? '900', GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_APPEARANCE: theme, KYBERN_FRAME_TIMES: '1', KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch, KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_URL: '', KYBERN_TOKEN: '', STREAM_PARAGRAPHS: '1', STREAM_INTERVAL: '40', STREAM_STOP: String(STOP), KYBERN_REPLY_CULL: mode === 'inline' ? '0' : '1', ...(process.env.KYBERN_FULL_RATE ? { KYBERN_FULL_RATE: '1' } : {}) }, { stderr: chunk => {
      const lines = (rest + chunk).split('\n'); rest = lines.pop() ?? ''
      if (window) for (const line of lines) { const m = /\[kybern-work\] renderMs=[\d.]+ layoutMs=([\d.]+)/.exec(line); if (m) layout.push(Number(m[1])) }
    } })
    try {
      await f.app.getByTestId('stream-ready').waitFor({ timeoutMs: 30000 })
      const started = Date.now()
      await Bun.sleep(10000)
      const before = f.frameTimes().length
      window = true
      await Bun.sleep(10000)
      window = false
      const stamps = f.frameTimes().slice(before)
      const frames = stamps.slice(1).map((value, i) => value - stamps[i]!)
      const mib = footprint(f.pid)
      console.log(`${theme} ${mode}: ${frames.length} frames in 10s, p50 ${percentile(frames, 0.5).toFixed(1)} p95 ${percentile(frames, 0.95).toFixed(1)} max ${Math.max(...frames).toFixed(1)} ms, >33ms ${frames.filter(v => v > 33.4).length}; footprint ${mib} MB; layout p50 ${percentile(layout, 0.5).toFixed(2)} p95 ${percentile(layout, 0.95).toFixed(2)} ms/frame; KYBERN_FULL_RATE=${process.env.KYBERN_FULL_RATE ?? 'unset'}`)
      // Wait for the stream to stop, then look at settled pieces well above the (blinking) tail.
      await Bun.sleep(Math.max(0, STOP * 40 + 3000 - (Date.now() - started)))
      // Deterministic positions: the top of the transcript (its pieces were spacers while the tail streamed), then a
      // fixed scroll down from there.
      const b = await f.app.getByTestId('stream-ready').bounds(), at = { x: b.x + b.width / 2, y: b.y + b.height / 2 }
      for (let i = 0; i < 6; i++) { await f.app.mouse.wheel(at, 0, 20000); await Bun.sleep(150) }
      await Bun.sleep(1200)
      for (const [name, delta] of [['top', 0], ['middle', -2400]] as const) {
        if (delta) { await f.app.mouse.wheel(at, 0, delta); await Bun.sleep(1500) }
        const path = `${out}/${theme}-${mode}-${name}.png`
        await f.app.screenshot({ path })
        shots[`${theme}-${mode}-${name}`] = path
      }
    } finally { await f.close(); rmSync(scratch, { recursive: true, force: true }) }
  }
} finally { release() }
for (const theme of themes) for (const name of ['top', 'middle']) {
  const a = shots[`${theme}-inline-${name}`], b = shots[`${theme}-culled-${name}`]
  if (!a || !b) continue
  const pa = pixels(a), pb = pixels(b)
  const same = pa.w === pb.w && pa.h === pb.h && pa.data.equals(pb.data)
  let differing = 0
  if (!same && pa.data.length === pb.data.length) for (let i = 0; i < pa.data.length; i++) if (pa.data[i] !== pb.data[i]) differing++
  console.log(`${theme} ${name}: culled pieces ${same ? 'paint identically to' : `differ from (${differing} bytes)`} always-mounted pieces`)
  if (!same) failed = true
}
process.exit(failed ? 1 : 0)
