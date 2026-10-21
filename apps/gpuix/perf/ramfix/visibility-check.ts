/**
 * Visibility, pause and resume on window-state events (no polling): minimize
 * and restore a full-product scratch window on the hidden test display and
 * assert the visibility change, hidden-window compaction and restore, the
 * background release (automation windows are never key, so it fires once,
 * BACKGROUND_RELEASE_MS after launch), and that frames stop while minimized and
 * resume after.
 *
 *   KYBERN_DATA_DIR=/Users/mymac/projects/ade-gpuix-scratch/motion-ramfix \
 *   KYBERN_BENCH_PORT=4386 bun perf/ramfix/visibility-check.ts
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { seed } from '../bench/seed.ts'
import { launchFixture } from '../../src/requests/harness.ts'
import { onExit } from '../bench/lifetime.ts'
import { lease } from '../memory/lease.ts'
import { assertTestDisplayWindow } from '../images/onscreen.ts'

const out = path.join(process.env.KYBERN_RAMFIX_EVIDENCE ?? '/Users/mymac/projects/ade/previews/motion/ramfix', 'visibility-check', process.env.KYBERN_RAMFIX_LABEL ?? (process.env.KYBERN_RAMFIX_BASELINE === '1' ? 'before' : 'after'))
mkdirSync(out, { recursive: true })
const addon = process.env.KYBERN_RAMFIX_ADDON ?? path.resolve(import.meta.dir, '../../native/build/gpuix-native.darwin-arm64.node')
// Baseline source and addon (before window-state events): no release to wait for.
const baseline = process.env.KYBERN_RAMFIX_BASELINE === '1'
const label = process.env.KYBERN_RAMFIX_LABEL ?? (baseline ? 'before' : 'after')
const fixture = await seed(process.env.KYBERN_DATA_DIR!, Number(process.env.KYBERN_BENCH_PORT ?? '4386'))
const dropFixture = onExit(() => fixture.close())
const release = await lease()
const client = path.join(process.env.KYBERN_DATA_DIR!, 'ramfix-visibility'); mkdirSync(client, { recursive: true })
let log = ''
const events: { at: number; line: string }[] = []
const f = await launchFixture(path.join(import.meta.dir, 'app.ts'), {
  ...fixture.env, NAPI_RS_NATIVE_LIBRARY_PATH: addon, KYBERN_GPUIX_RESOURCES: '', KYBERND: '', KYBERN_BUNDLED_CLI: '',
  KYBERN_CLIENT_CONFIG_DIR: client, KYBERN_GPUIX_CREDENTIALS_DIR: path.join(client, 'credentials'), KYBERN_GPUIX_THREAD: '',
  GPUIX_BACKGROUND: '1', KYBERN_HIDDEN_COMPACT: '1', KYBERN_DEBUG_VISIBILITY: '1', KYBERN_DEBUG_COMPACT: '1', KYBERN_DEBUG_IDLE_MEMORY: '1', KYBERN_FRAME_TIMES: '1', KYBERN_FULL_RATE: '1',
  // Loops in the scene, not Core Animation, so paused and resumed loops show as app frames.
  KYBERN_COMPOSITOR_LOOPS: '0',
}, { stderr: chunk => { log += chunk; for (const line of chunk.split('\n')) if (/\[(visibility|compact|idle-memory)\]/.test(line)) events.push({ at: performance.now(), line: line.trim() }) } })
  .catch(async error => { release(); await fixture.close(); throw error })
dropFixture()
const stop = onExit(async () => { await f.close(); await fixture.close(); release() })
const frames = () => (log.match(/\[kybern-frame\]/g) ?? []).length
const waitFor = async (pattern: RegExp, since: number, timeout = 3000) => {
  const deadline = performance.now() + timeout
  for (;;) {
    const hit = events.find(e => e.at >= since && pattern.test(e.line))
    if (hit) return hit.at - since
    assert(performance.now() < deadline, `No ${pattern} within ${timeout} ms; events: ${JSON.stringify(events.slice(-6))}`)
    await Bun.sleep(5)
  }
}
const result: Record<string, unknown> = {}
const launched = performance.now()
try {
  await f.app.getByTestId('app-ready').waitFor()
  const port = (name: string) => JSON.parse(readFileSync(path.join(client, `${name}-control.json`), 'utf8')).port as number
  const control = async (name: string, action: string, args: Record<string, unknown> = {}) => (await fetch(`http://127.0.0.1:${port(name)}`, { method: 'POST', body: JSON.stringify({ action, ...args }) })).json() as Promise<Record<string, unknown>>
  while (!(await control('bench', 'state')).listsLoaded) await Bun.sleep(50)
  // Keep the synthetic running row: its spinner is the loop that must pause and resume.
  await control('bench', 'open', { thread: fixture.manifest.long1000 })
  await assertTestDisplayWindow(f.pid)
  await Bun.sleep(3000)
  let mark = frames(); await Bun.sleep(2000)
  result.framesVisible2s = frames() - mark
  for (const round of [1, 2]) {
    let t = performance.now()
    await control('ramfix', 'minimize')
    result[`hiddenMs${round}`] = await waitFor(/\[visibility\] hidden/, t)
    result[`compactMs${round}`] = await waitFor(/\[compact\] released/, t)
    await Bun.sleep(1000); mark = frames(); await Bun.sleep(2000)
    result[`framesMinimized2s${round}`] = frames() - mark
    t = performance.now()
    await control('ramfix', 'restore')
    result[`visibleMs${round}`] = await waitFor(/\[visibility\] visible/, t)
    result[`restoreMs${round}`] = await waitFor(/\[compact\] restored/, t)
    await assertTestDisplayWindow(f.pid)
    await f.app.getByTestId('transcript-surface').waitFor()
    await Bun.sleep(1000); mark = frames(); await Bun.sleep(2000)
    result[`framesRestored2s${round}`] = frames() - mark
  }
  if (!baseline) result.idleReleaseAfterLaunchMs = await waitFor(/\[idle-memory\] released/, launched, 75000)
  result.events = events.map(e => e.line)
  writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 1))
  for (const round of [1, 2]) {
    assert.equal(result[`framesMinimized2s${round}`], 0, 'A minimized window presents no frames')
    assert((result[`framesRestored2s${round}`] as number) > 0, 'Loops resume after restore')
    // AppKit reports occlusion after the minimize/restore animation (~0.5 s).
    assert((result[`hiddenMs${round}`] as number) < 1500 && (result[`visibleMs${round}`] as number) < 1500, 'Visibility follows the window')
  }
  assert((result.framesVisible2s as number) > 0, 'The running row animates while visible')
  console.log(`ok ${label}: visibility, compaction, ${baseline ? '' : 'release, '}pause and resume`)
} finally { await f.close(); await fixture.close(); release(); stop() }
