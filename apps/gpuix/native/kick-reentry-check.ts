import '../src/native/local-build.ts'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launch, outputDir, step } from './check-harness.ts'
import { checkWindowOnscreenAsync } from '../perf/bench/window-onscreen.ts'

// Re-entrant drawable kick (ADE-110, macOS). 0.20.4 froze with a spinning cursor:
// the drawable gate kicked a starved layer inside a draw, its `[CATransaction flush]`
// ran AppKit's display cycle, and `resetCursorRects` waited on the window lock the
// draw held. The main thread deadlocked on itself.
//
// `frame-stall-lab.tsx` redraws 20 times a second and reports `getFrameWatchdog` once
// a second. `KYBERN_FRAME_STALL_TEST=kick-reentry:<ms>` makes a draw invalidate its
// view's cursor rects and kick the layer every <ms>; `flush-in-draw:<ms>` flushes the
// CA transaction inside the draw itself, which the window's AppKit callbacks must
// survive without the deferred kick. Before the fix both hang on the first fault:
// reports stop and `sample` shows `reset_cursor_rects` in `lock_slow`. After it, the
// window keeps drawing, the kicks are counted, and a cursor-rect update that found
// the window locked is applied on a later turn.
type Report = { frames: number; drawableKicks: number; labMaxLateMs: number; labBlocks: number }

const FAULT_SECONDS = 7

async function run(fault: string) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'gpuix-kick-reentry-'))
  let text = ''
  const f = await launch(path.join(import.meta.dir, 'frame-stall-lab.tsx'), { KYBERN_NO_ACTIVATE: '1', KYBERN_DATA_DIR: scratch, KYBERN_URL: '', KYBERN_FRAME_STALL_TEST: `${fault}:1000` }, { stderr: chunk => { text += chunk } })
  const reports = () => text.split('\n').filter(line => line.startsWith('[frame-stall-lab] {')).map(line => JSON.parse(line.slice(line.indexOf('{'))) as Report)
  const count = (needle: string) => text.split('\n').filter(line => line.includes(needle)).length
  try {
    await f.app.getByTestId('app-ready').waitFor({ timeoutMs: 30_000 })
    await checkWindowOnscreenAsync(f.pid)
    const started = reports().length
    await Bun.sleep(FAULT_SECONDS * 1000)
    const after = reports().slice(started)
    let stack = ''
    if (after.length < FAULT_SECONDS - 2) {
      // Hung: keep the main thread's stack as evidence.
      try { stack = execFileSync('sample', [String(f.pid), '1'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 }) } catch {}
      writeFileSync(path.join(outputDir('kick-reentry'), `${fault}-hang-sample.txt`), stack)
    } else await checkWindowOnscreenAsync(f.pid)
    return {
      reports: after.length,
      frames: after.length ? after.at(-1)!.frames - after[0]!.frames : 0,
      kicks: after.at(-1)?.drawableKicks ?? 0,
      maxLate: Math.max(0, ...after.map(r => r.labMaxLateMs)),
      blocks: after.at(-1)?.labBlocks ?? 0,
      faults: count('[frame-drawable] test: kick inside a draw') + count('[frame-drawable] test: CA flush inside a draw'),
      continued: count('[frame-drawable] test: the draw continues'),
      deferred: count('[frame-window] resetCursorRects re-entered'),
      applied: count('[frame-window] resetCursorRects applied after a deferral'),
      deadlock: /reset_cursor_rects[\s\S]{0,4000}lock_slow/.test(stack),
    }
  } finally { await f.close(); rmSync(scratch, { recursive: true, force: true }) }
}

const failures: string[] = []
const expect = (name: string, ok: boolean, detail: string) => {
  const line = `${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`
  console.log(line)
  if (!ok) failures.push(line)
}

for (const fault of ['kick-reentry', 'flush-in-draw']) {
  await step(fault, async () => {
    const r = await run(fault)
    const detail = `${r.reports} reports in ${FAULT_SECONDS} s, ${r.frames} frames, ${r.faults} faults, ${r.continued} draws continued, ${r.kicks} kicks, longest ${r.maxLate} ms late, ${r.deferred} cursor updates deferred, ${r.applied} applied later${r.deadlock ? '; sampled: reset_cursor_rects waiting in lock_slow' : ''}`
    expect(`${fault}: the window keeps drawing`, r.faults >= 3 && r.continued === r.faults && r.reports >= FAULT_SECONDS - 2 && r.frames > 20 * (FAULT_SECONDS - 3) && r.blocks === 0, detail)
    // The last report can precede the last fault by up to a second. The kick's flush
    // runs after the draw, so nothing re-enters the locked window.
    if (fault === 'kick-reentry') expect(`${fault}: kicks counted, flushed outside the draw`, r.kicks >= r.faults - 1 && r.kicks > 0 && r.deferred === 0, `${r.kicks} kicks for ${r.faults} faults, ${r.deferred} callbacks found the window locked`)
    // A flush inside the draw re-enters resetCursorRects with the window locked: it
    // defers instead of waiting, and the rects are set on a later turn.
    else expect(`${fault}: locked cursor-rect updates deferred and applied`, r.deferred >= 1 && r.applied >= 1, `${r.deferred} deferred, ${r.applied} applied`)
  })
}
if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log('ok  a drawable kick inside a draw no longer deadlocks the main thread')
