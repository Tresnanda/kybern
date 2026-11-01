import { expect, test } from 'bun:test'
import { FramePoller } from './poll.ts'
import type { ComputerFrameResult } from '../../../../packages/kybern-client/src/types.ts'
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
test('hidden and stopped views make no requests, late frames are discarded', async () => {
  let calls = 0, frames = 0, resolve!: (r: ComputerFrameResult) => void
  const poll = new FramePoller('test', () => { calls++; return new Promise(r => { resolve = r }) }, () => { frames++ }, Date.now(), 5)
  poll.show(false); await pause(15); expect(calls).toBe(0)
  poll.show(true); expect(calls).toBe(1)
  poll.show(false); resolve({ frame: { seq: 1, window_id: 0, app: 'fixture', media_type: 'image/png', data: '', width: 1, height: 1, captured_at: new Date().toISOString() } })
  await pause(15); expect(frames).toBe(0); expect(calls).toBe(1)
  poll.show(true); expect(calls).toBe(2); poll.stop(); resolve({ frame: null }); await pause(15); expect(calls).toBe(2)
})
test('a paused answer is reported and polling continues at the normal rate', async () => {
  const reasons: (string | null)[] = []
  let calls = 0
  const poll = new FramePoller('test', async () => { calls++; return calls < 3 ? { frame: null, paused: 'Screenshot consent was declined' } : { frame: null } }, () => {}, Date.now(), 5)
  poll.onPaused = reason => reasons.push(reason)
  poll.show(true); await pause(60); poll.stop()
  expect(reasons.slice(0, 3)).toEqual(['Screenshot consent was declined', 'Screenshot consent was declined', null])
  expect(calls).toBeGreaterThanOrEqual(3)
})
