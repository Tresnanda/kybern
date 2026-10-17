// Hidden-window compaction in a real window: open a long thread, scroll to the
// middle, minimize (AppKit miniaturize, KYBERN_DEBUG_SURFACE), check the
// transcript is released and the process footprint, then deminiaturize and
// check the thread rehydrates at the same reading position. Also checks blur
// alone never compacts (the window starts unfocused and stays mounted).
//
//   KYBERN_DATA_DIR=<scratch> bun src/platform/verify.compact.ts <thread title prefix> <out-dir> [dark|light] [reduced]
import '../native/local-build.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
import { pixels } from '../../native/png.ts'
import { until, windowId } from './verify.lib.ts'

const [title, out = '/tmp/compact', theme = 'dark', motion] = process.argv.slice(2) as [string, string?, string?, string?]
const mode = `${theme}${motion === 'reduced' ? '-reduced' : ''}`
mkdirSync(out, { recursive: true })
const MINIMIZE = 25_000, RESTORE = 35_000
const app = await launch({ command: 'bun', args: [path.join(import.meta.dir, '../main.tsx')], env: {
  GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: motion === 'reduced' ? '1' : '0', KYBERN_GPUIX_THREAD: title,
  KYBERN_HIDDEN_COMPACT: '1', KYBERN_DEBUG_SURFACE: `minimize@${MINIMIZE},restore@${RESTORE}`,
} })
const started = Date.now()
const footprint = (pid: number) => Number(/Footprint:\s+([\d.]+) MB/.exec(execFileSync('footprint', [String(pid)], { encoding: 'utf8' }))?.[1] ?? NaN)
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  const { pid } = await app.call('initialize', { protocolVersion: 1, client: 'compact-check' }) as { pid: number }
  const id = windowId(pid)
  await until(async () => (await app.getByTestId('transcript-loading').count()) === 0 && (await app.getByTestId('transcript-released').count()) === 0, 'transcript shown', 20_000)
  await Bun.sleep(1500)
  // Scroll into the middle of the answer.
  for (let i = 0; i < 6; i++) { await app.getByTestId('app-ready').wheel(0, -400); await Bun.sleep(120) }
  await Bun.sleep(1200)
  const shot = (name: string) => { const file = path.join(out, `${name}-${mode}.png`); execFileSync('screencapture', ['-x', '-o', '-l', String(id), file]); return file }
  const before = shot('1-scrolled')
  const mountedFootprint = footprint(pid)
  console.log(`blur-only (unfocused, on screen): released=${await app.getByTestId('transcript-released').count()}`)
  assert.ok(Date.now() - started < MINIMIZE, 'setup finished before the minimize step')
  await until(async () => (await app.getByTestId('transcript-released').count()) > 0, 'released after minimize', MINIMIZE + 8000 - (Date.now() - started))
  console.log(`ok  minimized → transcript released ${Date.now() - started - MINIMIZE} ms after miniaturize`)
  await Bun.sleep(3000)
  const hiddenFootprint = footprint(pid)
  console.log(`footprint mounted ${mountedFootprint} MB → released ${hiddenFootprint} MB`)
  await until(async () => (await app.getByTestId('transcript-released').count()) === 0, 'restored after deminiaturize', RESTORE + 10_000 - (Date.now() - started))
  await until(async () => (await app.getByTestId('transcript-loading').count()) === 0, 'rehydrated', 15_000)
  await Bun.sleep(2500)
  const after = shot('2-restored')
  // The transcript column (right of the panel, above the composer) must be where it was.
  const a = pixels(before), b = pixels(after)
  let diff = 0, total = 0
  for (let y = 120; y < a.h - 500; y += 4) for (let x = 1000; x < a.w - 200; x += 4) { total++; if (a.at(x, y).some((v, i) => Math.abs(v - b.at(x, y)[i]!) > 24)) diff++ }
  console.log(`transcript region differing after restore: ${(100 * diff / total).toFixed(2)}%`)
  assert.ok(diff / total < 0.02, 'reading position restored')
  console.log(`ok  ${mode}: restored at the saved reading position`)
} finally { await app.close() }
process.exit(0)
