import { expect, test } from 'bun:test'
import type { WindowStateReport } from './windowState.ts'

const FRESH: string = './windowState.ts?report-test'
// A module instance of its own: the window-state singleton is shared by every test file in the run (`idleMemory.test.ts`).
const { hasWindowStateEvents, installWindowState, onWindowStateChange, windowStateReport } = await import(FRESH) as typeof import('./windowState.ts')

test('off macOS each delivery carries the window state, kept for the readers', () => {
  let deliver: ((error: Error | null, report?: WindowStateReport | null) => void) | null = null
  let acknowledged = 0
  const heard: (WindowStateReport | null)[] = []
  onWindowStateChange(() => heard.push(windowStateReport()))
  expect(installWindowState({ setWindowStateCallback: (cb: typeof deliver) => { deliver = cb }, acknowledgeWindowState: () => { acknowledged++ } })).toBe(true)
  expect(hasWindowStateEvents()).toBe(true)
  // Installing calls the listeners once, before any report arrived.
  expect(heard).toEqual([null])
  deliver!(null, { minimized: true, visible: false, focused: false })
  expect(windowStateReport()).toEqual({ minimized: true, visible: false, focused: false })
  // A macOS-style delivery without a report keeps the last one.
  deliver!(null, null)
  expect(windowStateReport()?.minimized).toBe(true)
  deliver!(null, { minimized: false, visible: true, focused: true })
  expect(heard.at(-1)).toEqual({ minimized: false, visible: true, focused: true })
  expect(acknowledged).toBe(3)
})
