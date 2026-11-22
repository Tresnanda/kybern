import { expect, test } from 'bun:test'
import type { ProviderStatus } from '../../../../packages/kybern-client/src/types.ts'
import { CURSOR_UPDATE_GIVE_UP_MS, CURSOR_UPDATE_POLL_MS, cursorIsUpdating, followCursorUpdate } from './cursorUpdate.ts'

const cursor = (over: Partial<ProviderStatus> = {}): ProviderStatus => ({ kind: 'cursor', display_name: 'Cursor', available: false, supported_permission_modes: [], supports_fork: false, supports_model_switch: false, instances: [], unavailable_reason: 'Updating Cursor’s SDK from 1.2.0 to 1.4.2. Cursor will be ready in a minute.', ...over })

function harness(installing: () => boolean) {
  let clock = 0, visible = true, id = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const listeners = new Set<(v: boolean) => void>()
  const calls = { status: 0, reload: 0 }
  const follower = followCursorUpdate({
    status: async () => { calls.status++; return { installing: installing() } },
    reload: () => { calls.reload++ },
    isVisible: () => visible,
    onVisibility: (l) => { listeners.add(l); return () => listeners.delete(l) },
    now: () => clock,
    setTimer: (fn, ms) => { timers.set(++id, { at: clock + ms, fn }); return id },
    clearTimer: (t) => { timers.delete(t as number) },
  })
  const advance = async (ms: number) => {
    clock += ms
    for (const [k, t] of [...timers]) if (t.at <= clock) { timers.delete(k); t.fn() }
    await Promise.resolve(); await Promise.resolve()
  }
  return { follower, calls, timers, advance, setVisible: (v: boolean) => { visible = v; listeners.forEach((l) => l(v)) } }
}

test('only an updating Cursor counts', () => {
  expect(cursorIsUpdating([cursor()])).toBe(true)
  expect(cursorIsUpdating([cursor({ available: true, unavailable_reason: null })])).toBe(false)
  expect(cursorIsUpdating([cursor({ unavailable_reason: 'Cursor’s SDK isn’t installed.' })])).toBe(false)
  expect(cursorIsUpdating([])).toBe(false)
})

test('nothing polls while Cursor is not updating', async () => {
  const h = harness(() => true)
  h.follower.observe([cursor({ available: true, unavailable_reason: null })])
  h.follower.observe([])
  await h.advance(CURSOR_UPDATE_POLL_MS * 5)
  expect(h.follower.polling()).toBe(false)
  expect(h.calls).toEqual({ status: 0, reload: 0 })
})

test('an updating Cursor polls once per interval, then reloads exactly once and stops', async () => {
  let installing = true
  const h = harness(() => installing)
  h.follower.observe([cursor()])
  h.follower.observe([cursor()]) // more provider updates do not start a second poller
  expect(h.timers.size).toBe(1)
  await h.advance(CURSOR_UPDATE_POLL_MS)
  await h.advance(CURSOR_UPDATE_POLL_MS)
  expect(h.calls).toEqual({ status: 2, reload: 0 })
  installing = false
  await h.advance(CURSOR_UPDATE_POLL_MS)
  expect(h.calls).toEqual({ status: 3, reload: 1 })
  expect(h.follower.polling()).toBe(false)
  expect(h.timers.size).toBe(0)
  await h.advance(CURSOR_UPDATE_POLL_MS * 5)
  expect(h.calls).toEqual({ status: 3, reload: 1 })
})

test('it pauses while the window is hidden and resumes when it shows', async () => {
  const h = harness(() => true)
  h.follower.observe([cursor()])
  h.setVisible(false)
  await h.advance(CURSOR_UPDATE_POLL_MS * 5)
  expect(h.calls.status).toBe(0)
  h.setVisible(true)
  await h.advance(0)
  expect(h.calls.status).toBe(1)
})

test('it gives up after ten minutes without reloading', async () => {
  const h = harness(() => true)
  h.follower.observe([cursor()])
  for (let t = 0; t <= CURSOR_UPDATE_GIVE_UP_MS; t += CURSOR_UPDATE_POLL_MS) await h.advance(CURSOR_UPDATE_POLL_MS)
  expect(h.follower.polling()).toBe(false)
  expect(h.calls.reload).toBe(0)
  const seen = h.calls.status
  await h.advance(CURSOR_UPDATE_POLL_MS * 3)
  expect(h.calls.status).toBe(seen)
})
