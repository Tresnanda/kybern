import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { EventPayload } from '@gpuix/react'
import { setKeyPlatform } from '../platform/keys.ts'
import { reloadPrefs, writePref } from '../platform/prefs.ts'
import { noteTerminalFocus, terminalHasFocus } from '../terminal/focus.ts'
import { onWindowKeyDown } from '../nav/keys.ts'
import {
  availableSteps, fittingZoom, zoomKey, formatZoom, getUiZoom, installUiZoom, launchWindowOptions, minWindowSize, nextStep, onZoomAnnounce, resetUiZoomForTests, setUiZoom, snapToStep, stepFits,
  type UiZoomReport, type ZoomAnnouncement,
} from './uiZoom.ts'

const press = (key: string, modifiers: Partial<NonNullable<EventPayload['modifiers']>>) =>
  onWindowKeyDown({ key, modifiers: { cmd: false, ctrl: false, alt: false, shift: false, ...modifiers } } as unknown as EventPayload)

/** A window on a 1512×945 display (a 14" MacBook Pro's default): 150 % fits, 175 % does not. */
function fakeRenderer(display = { width: 1512, height: 945 }) {
  const calls: Array<[number, number | undefined, number | undefined]> = []
  let zoom = 1
  const report = (): UiZoomReport => ({ zoom, scale: 2, displayWidth: display.width, displayHeight: display.height })
  return {
    calls,
    renderer: {
      getUiZoom: report,
      setUiZoom: (next: number, width?: number, height?: number) => { calls.push([next, width, height]); zoom = next; return report() },
      setMenuCommandCallback: () => {},
    },
  }
}

/** Another window's save of the size, straight to app.json. */
function writeSaved(zoom: number) {
  writePref('ui.zoom', zoom)
}

let config: string
let restoreKeys: (() => void) | null = null
beforeEach(() => {
  config = mkdtempSync(path.join(tmpdir(), 'kybern-zoom-'))
  process.env.KYBERN_CLIENT_CONFIG_DIR = config
  reloadPrefs()
  resetUiZoomForTests()
})
afterEach(() => {
  restoreKeys?.(); restoreKeys = null
  while (terminalHasFocus()) noteTerminalFocus(false)
  rmSync(config, { recursive: true, force: true })
})

describe('steps', () => {
  test('snap, format and the minimum window per step', () => {
    expect(snapToStep(1.12)).toBe(1.1)
    expect(snapToStep('x')).toBe(1)
    expect(snapToStep(3)).toBe(2)
    expect(formatZoom(1.25)).toBe('125%')
    expect(minWindowSize(1.5)).toEqual({ width: 1350, height: 900 })
  })
  test('sizes that do not fit the display are unavailable, and the steps skip them', () => {
    const display = { width: 1512, height: 945 }
    expect(stepFits(1.5, display)).toBe(true)
    expect(stepFits(1.75, display)).toBe(false)
    expect(availableSteps(display)).toEqual([0.8, 0.9, 1, 1.1, 1.25, 1.5])
    expect(nextStep(1.5, 1, display)).toBeNull()
    expect(nextStep(1.25, 1, display)).toBe(1.5)
    expect(nextStep(0.8, -1, display)).toBeNull()
    expect(fittingZoom(2, display)).toBe(1.5)
    // An unknown display allows every step.
    expect(availableSteps(null)).toHaveLength(8)
  })
})

describe('applying', () => {
  test('a zoom sets the minimum window first and is saved for the device', () => {
    const fake = fakeRenderer()
    installUiZoom(fake.renderer)
    expect(setUiZoom(1.25)).toBe(1.25)
    expect(fake.calls.at(-1)).toEqual([1.25, 1125, 750])
    expect(getUiZoom()).toBe(1.25)
    // A new window reads the saved value.
    resetUiZoomForTests()
    const next = fakeRenderer()
    installUiZoom(next.renderer)
    expect(next.calls.at(-1)?.[0]).toBe(1.25)
  })
  test('a saved size too large for this display opens at the largest that fits', () => {
    setUiZoom(2)
    resetUiZoomForTests()
    const fake = fakeRenderer({ width: 1280, height: 800 })
    installUiZoom(fake.renderer)
    expect(getUiZoom()).toBe(1.25)
  })
  test('a window opens zoomed with the 100 % minimum, and grows once it knows the display', () => {
    setUiZoom(2)
    resetUiZoomForTests({ zoom: 2 })
    // A display smaller than 200 %'s minimum (1800×1200) must not get a window that large before the zoom drops.
    expect(launchWindowOptions()).toMatchObject({ uiZoom: 2, minWidth: 900, minHeight: 600 })
    const fake = fakeRenderer({ width: 1512, height: 945 })
    installUiZoom(fake.renderer)
    expect(fake.calls.at(-1)).toEqual([1.5, 1350, 900])
  })
  test('another window hears a size change at once and applies it', () => {
    let told = 0
    let heard: (() => void) | null = null
    const first = fakeRenderer()
    installUiZoom(first.renderer, undefined, { tell: () => { told++ }, listen: () => {} })
    setUiZoom(1.25)
    expect(told).toBe(1)
    // The other process: its own module state, the same app.json.
    resetUiZoomForTests()
    const second = fakeRenderer()
    installUiZoom(second.renderer, undefined, { tell: () => { told++ }, listen: (listener) => { heard = listener } })
    expect(getUiZoom()).toBe(1.25)
    setUiZoom(1.5)
    expect(told).toBe(2)
    resetUiZoomForTests()
    const third = fakeRenderer()
    installUiZoom(third.renderer, undefined, { tell: () => { told++ }, listen: (listener) => { heard = listener } })
    expect(getUiZoom()).toBe(1.5)
    // The first window's message: re-read and apply, without telling the others again.
    setUiZoom(1)
    resetUiZoomForTests({ zoom: 1.5 })
    const fourth = fakeRenderer()
    installUiZoom(fourth.renderer, undefined, { tell: () => { told++ }, listen: (listener) => { heard = listener } })
    const before = told
    writeSaved(1.1)
    heard!()
    expect(getUiZoom()).toBe(1.1)
    expect(told).toBe(before)
  })
  test('zooming in at the largest size that fits says so', () => {
    const fake = fakeRenderer()
    installUiZoom(fake.renderer)
    setUiZoom(1.5)
    const heard: ZoomAnnouncement[] = []
    onZoomAnnounce((a) => heard.push(a))
    restoreKeys = setKeyPlatform('darwin')
    press('=', { cmd: true })
    expect(getUiZoom()).toBe(1.5)
    expect(heard).toEqual([{ zoom: 1.5, limit: true }])
  })
})

describe('shortcuts', () => {
  test('⌘= ⌘⇧= ⌘+ zoom in, ⌘− out, ⌘0 back to actual size', () => {
    restoreKeys = setKeyPlatform('darwin')
    installUiZoom(fakeRenderer().renderer)
    const heard: number[] = []
    onZoomAnnounce((a) => heard.push(a.zoom))
    press('=', { cmd: true })
    press('=', { cmd: true, shift: true })
    press('+', { cmd: true, shift: true })
    expect(getUiZoom()).toBe(1.5)
    press('-', { cmd: true })
    expect(getUiZoom()).toBe(1.25)
    press('0', { cmd: true })
    expect(getUiZoom()).toBe(1)
    expect(heard).toEqual([1.1, 1.25, 1.5, 1.25, 1])
    // ⌃= is not the shortcut on macOS.
    press('=', { ctrl: true })
    expect(getUiZoom()).toBe(1)
  })
  for (const platform of ['win32', 'linux'] as const) test(`${platform}: Ctrl+= works with a focused terminal; AltGr does not zoom`, () => {
    restoreKeys = setKeyPlatform(platform)
    installUiZoom(fakeRenderer().renderer)
    noteTerminalFocus(true)
    press('=', { ctrl: true })
    expect(getUiZoom()).toBe(1.1)
    press('0', { ctrl: true })
    expect(getUiZoom()).toBe(1)
    // AltGr arrives as Ctrl+Alt.
    expect(zoomKey({ key: '0', modifiers: { ctrl: true, alt: true, cmd: false, shift: false } } as never)).toBeNull()
    press('=', { ctrl: true, alt: true })
    expect(getUiZoom()).toBe(1)
  })
})
