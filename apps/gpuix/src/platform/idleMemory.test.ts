// One file: the window-state bridge installs once per process.
import { expect, test } from 'bun:test'
import { hasWindowStateEvents, installWindowState, onWindowStateChange } from '../native/windowState.ts'
import { installIdleMemory, releaseIdleMemory } from './idleMemory.ts'

let deliver: ((error: Error | null) => void) | null = null
const order: string[] = []

test('window-state events: none without the callback; one install, acknowledged before listeners', () => {
  expect(installWindowState({})).toBe(false)
  expect(hasWindowStateEvents()).toBe(false)
  const renderer = {
    setWindowStateCallback(callback: (error: Error | null) => void) { deliver = callback },
    acknowledgeWindowState() { order.push('ack') },
  }
  const stop = onWindowStateChange(() => order.push('listener'))
  try {
    expect(installWindowState(renderer)).toBe(true)
    expect(hasWindowStateEvents()).toBe(true)
    // Listeners hear once at install, so pollers can stop polling.
    expect(order).toEqual(['listener'])
    deliver!(null)
    expect(order).toEqual(['listener', 'ack', 'listener'])
    // A second renderer does not replace the first callback.
    expect(installWindowState({ setWindowStateCallback() { throw Error('replaced') } })).toBe(true)
  } finally { stop() }
  deliver!(null)
  expect(order.at(-1)).toBe('ack')
})

test('release asks the renderer, then collects; an old addon is tolerated', () => {
  let calls = 0
  expect(releaseIdleMemory({ releaseIdleMemory: () => { calls++; return { gpuBytes: 7 } } }).gpuBytes).toBe(7)
  expect(calls).toBe(1)
  expect(releaseIdleMemory({}).gpuBytes).toBe(0)
})

test('background release: once per background period, re-armed by focus', async () => {
  let focused = true, releases = 0
  installIdleMemory({ releaseIdleMemory: () => { releases++; return { gpuBytes: 0 } } }, () => focused, 20)
  await Bun.sleep(40)
  expect(releases).toBe(0)
  focused = false; deliver!(null)
  await Bun.sleep(60)
  expect(releases).toBe(1)
  deliver!(null); await Bun.sleep(60)
  expect(releases).toBe(1)
  // Back in front before the delay: nothing is released.
  focused = true; deliver!(null); await Bun.sleep(5)
  focused = false; deliver!(null); await Bun.sleep(5)
  focused = true; deliver!(null); await Bun.sleep(60)
  expect(releases).toBe(1)
  focused = false; deliver!(null); await Bun.sleep(60)
  expect(releases).toBe(2)
})
