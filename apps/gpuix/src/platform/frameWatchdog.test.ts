import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { frameLogLine, installFrameWatchdogLog, type FrameWatchdogReport } from './frameWatchdog.ts'

const base: FrameWatchdogReport = { frames: 100, stalls: 0, repairs: 0, lastStall: null, droppedFrames: 0, representedFrames: 0, slowDrawables: 0, maxDrawableWaitMs: 0 }
const at = new Date('2026-10-29T06:00:00Z')

test('a line only when a stall or a dropped drawable was added', () => {
  expect(frameLogLine(base, { ...base, frames: 200 }, at)).toBeNull()
  expect(frameLogLine(base, { ...base, stalls: 1, repairs: 1, lastStall: 'SilentLink(2) on screen 2' }, at))
    .toBe('2026-10-29T06:00:00.000Z; stall x1 (1 repaired in total): SilentLink(2) on screen 2; slow drawables 0, longest wait 0 ms\n')
  expect(frameLogLine(null, { ...base, droppedFrames: 2, representedFrames: 2, slowDrawables: 3, maxDrawableWaitMs: 1001.4 }, at))
    .toBe('2026-10-29T06:00:00.000Z; no drawable x2 (2 presented again in total); slow drawables 3, longest wait 1001 ms\n')
})

test('appends the report from window-state events', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'frame-watchdog-'))
  try {
    let deliver = () => {}
    let report = base
    const file = path.join(dir, 'gpuix-frames.log')
    installFrameWatchdogLog({ getFrameWatchdog: () => report }, file, listener => { deliver = listener; return () => {} })
    deliver()
    report = { ...report, stalls: 1, repairs: 1, lastStall: 'Unsubscribed on screen 1' }
    deliver()
    deliver()
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('stall x1 (1 repaired in total): Unsubscribed on screen 1')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
