import { expect, test } from 'bun:test'
import { watchPointerRelease } from './release.ts'

test('outside release cancels without any element event, after the commit grace period', async () => {
  let pressed = true, cancelled = 0
  const stop = watchPointerRelease(() => ({ pressed, active: true }), () => cancelled++)
  try {
    await Bun.sleep(50)
    expect(cancelled).toBe(0)
    pressed = false
    await Bun.sleep(50)
    expect(cancelled).toBe(0)
    await Bun.sleep(180)
    expect(cancelled).toBe(1)
  } finally { stop() }
})

test('window deactivation cancels a held gesture', async () => {
  let active = true, cancelled = 0
  const stop = watchPointerRelease(() => ({ pressed: true, active }), () => cancelled++)
  try {
    active = false
    await Bun.sleep(80)
    expect(cancelled).toBe(1)
  } finally { stop() }
})

test('ordinary release disposes the watchdog before its fallback can run', async () => {
  let cancelled = 0
  const stop = watchPointerRelease(() => ({ pressed: true, active: true }), () => cancelled++)
  stop()
  await Bun.sleep(180)
  expect(cancelled).toBe(0)
})

test('synthetic events do not arm a physical watchdog', async () => {
  let reads = 0
  const stop = watchPointerRelease(() => { reads++; return { pressed: false, active: false } }, () => { throw Error('Unexpected cancellation') })
  await Bun.sleep(80)
  stop()
  expect(reads).toBe(1)
})
