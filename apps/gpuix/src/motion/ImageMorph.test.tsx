import { afterAll, expect, mock, test } from 'bun:test'
import { setKeyPlatform } from '../platform/keys.ts'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import type { ReactNode } from 'react'

// Written for macOS shortcuts (⌘, ⌃); the off-macOS cases set their platform themselves. CI runs these on Linux.
const restoreKeys = setKeyPlatform('darwin')
afterAll(() => restoreKeys())

mock.module('../native/visibility.ts', () => ({ isWindowVisible: () => true, onWindowVisibility: () => () => {} }))
// Spread the real module: its other exports (BACKDROP_BLUR, …) are read by modules this file imports.
const localBuild = await import('../native/local-build.ts')
mock.module('../native/local-build.ts', () => ({ ...localBuild, PATCHED_NATIVE: true }))
const { fallbackTo, ImageViewer, LANDED, lightboxArea, lightboxLayout, lightboxRect, morphFrom, onScreen, MORPH_OPEN, MORPH_CLOSE } = await import('./ImageMorph.tsx')
const { ThemeProvider } = await import('../ui.tsx')
const entry = createRequire(import.meta.url).resolve('@gpuix/react')
const { createRoot, flushSync } = await import(pathToFileURL(path.join(path.dirname(entry), 'reconciler/reconciler.js')).href)
const { handleGpuixEvent } = await import(pathToFileURL(path.join(path.dirname(entry), 'reconciler/event-registry.js')).href)

const image = new URL('../../packaging/icons/128x128@2x.png', import.meta.url).pathname
const WINDOW = { width: 1200, height: 800 }

test('a cropped thumbnail maps to the scale it shows the image at, clipped to its box with its own radius', () => {
  const to = { x: 100, y: 100, width: 1000, height: 562 }
  const { outer, inner } = morphFrom({ rect: { x: 10, y: 700, width: 64, height: 64 }, radius: 11, fit: 'cover' }, to, true)
  expect(outer.scale).toBeCloseTo(64 / 562)
  expect(outer.translateX).toBe(42 - 600)
  expect(outer.translateY).toBe(732 - 381)
  expect(outer.shadowOpacity).toBe(0)
  // The 64 px square shows the middle 562 × 562 of the image.
  expect(inner).toEqual({ clipTop: 0, clipBottom: 0, clipLeft: 219, clipRight: 219, clipRadius: 11 })
  // A reply image shows all of it: no crop.
  const reply = morphFrom({ rect: { x: 0, y: 0, width: 280, height: 157.36 }, radius: 12, fit: 'contain' }, to, true)
  expect(reply.outer.scale).toBeCloseTo(0.28)
  expect(reply.inner.clipLeft).toBeCloseTo(0)
  expect(reply.inner.clipTop).toBeCloseTo(0)
  // An addon without `paintClip`: the plain zoom by width, nothing clipped.
  expect(morphFrom({ rect: { x: 10, y: 700, width: 64, height: 64 }, radius: 11, fit: 'cover' }, to, false)).toMatchObject({ outer: { scale: 0.064 }, inner: {} })
})

test('a thumbnail that left the screen gets a shrink and fade towards where it was, inside the window', () => {
  expect(onScreen({ x: 10, y: 10, width: 64, height: 64 }, WINDOW)).toBe(true)
  expect(onScreen({ x: 10, y: -50, width: 64, height: 64 }, WINDOW)).toBe(false)
  expect(onScreen(null, WINDOW)).toBe(false)
  const to = lightboxRect(WINDOW, { width: 256, height: 256 })
  const back = fallbackTo({ rect: { x: 40, y: -400, width: 64, height: 64 }, radius: 12, fit: 'cover' }, WINDOW, to, true)
  expect(back.outer.opacity).toBe(0)
  expect(back.outer.translateY).toBe(32 - (to.y + to.height / 2))
})

function harness() {
  const custom = new Map<number, Record<string, any>>(), style = new Map<number, Record<string, any>>(), moves: string[] = [], children = new Map<number, number[]>()
  let resized: ((error: Error | null, event: unknown) => void) | undefined
  const renderer = {
    applyBatch(json: string) {
      for (const [op, id, a, b] of JSON.parse(json) as [string, number, any, any][]) {
        if (op === 'createElement') custom.set(id, {})
        else if (op === 'setCustomProp') custom.get(id)![a] = b
        else if (op === 'setStyle') style.set(id, a)
        else if (op === 'appendChild') children.set(id, [...(children.get(id) ?? []), a])
      }
      return []
    },
    setWindowKeyEvents() {}, setWindowSelectionChange() {},
    addLayoutObserver: (target: unknown, callback: (error: Error | null, event: unknown) => void) => { if (target === null) resized = callback; return 1 },
    removeLayoutObserver() {}, isLayoutObserverActive: () => true,
    getWindowSize: () => WINDOW,
    getMotionCapabilities: () => ({ rotate: true, physicalSprings: true, paintClip: true }),
    focusNextWithin: (id: number) => moves.push(`next:${id}`),
    focusPreviousWithin: (id: number) => moves.push(`previous:${id}`),
  }
  const root = createRoot(renderer)
  const render = (node: ReactNode) => flushSync(() => root.render(<ThemeProvider>{node}</ThemeProvider>))
  const id = (testId: string) => [...custom].find(([, props]) => props.testId === testId)![0]
  const props = (testId: string) => custom.get(id(testId))!
  const fire = (testId: string, payload: Record<string, unknown>) => flushSync(() => handleGpuixEvent({ elementId: id(testId), ...payload }, renderer))
  return { root, render, id, props, fire, style, moves, children, resize: (event: unknown) => flushSync(() => resized!(null, event)), custom }
}

test('a pointer open morphs from the thumbnail and a pointer close returns into where it is now', () => {
  const h = harness()
  const from = { rect: { x: 40, y: 600, width: 64, height: 64 }, radius: 11, fit: 'cover' as const }
  let now: typeof from | null = from
  const closed: string[] = []
  h.render(<ImageViewer testId="viewer" src={image} label="icon.png" from={from} source={() => now} onClose={() => closed.push('closed')} />)
  const rect = lightboxRect(WINDOW, { width: 256, height: 256 }), area = lightboxArea(WINDOW)
  const start = morphFrom(from, rect, true, area)
  const outer = h.props('viewer-image').paintTransform, inner = [...h.custom.values()].find(p => p.paintTransform?.animate?.clipRadius !== undefined)!.paintTransform
  expect(outer).toMatchObject({ initial: start.outer, animate: LANDED.outer, transition: MORPH_OPEN })
  expect(inner).toMatchObject({ initial: start.inner, animate: LANDED.inner, transition: MORPH_OPEN })
  // The scrim and the toolbar share the image's timing; the timing is the iOS zoom curve at 260 ms open, 200 ms back.
  expect(h.props('viewer-bar').paintTransform.transition).toEqual(MORPH_OPEN)
  expect(h.props('viewer-scrim').paintTransform.transition).toEqual(MORPH_OPEN)
  expect(MORPH_OPEN).toEqual({ duration: 0.26, ease: [0.32, 0.72, 0, 1] })
  expect(MORPH_CLOSE).toEqual({ duration: 0.2, ease: [0.32, 0.72, 0, 1] })
  // The thumbnail moved while the preview was open; the close lands on its new rect, retargeting from the value on screen.
  now = { ...from, rect: { ...from.rect, y: 500 } }
  h.fire('viewer-scrim', { eventType: 'click' })
  const back = morphFrom(now, rect, true, area)
  const closing = h.props('viewer-image').paintTransform
  expect(closing).toMatchObject({ initial: false, animate: back.outer, transition: MORPH_CLOSE })
  expect(closed).toEqual([])
  expect(h.props('viewer-bar').paintTransform.transition).toEqual(MORPH_CLOSE)
  expect(h.props('viewer-scrim').paintTransform.transition).toEqual(MORPH_CLOSE)
  h.fire('viewer-image', { eventType: 'motionComplete', motionGeneration: closing.generation })
  expect(closed).toEqual(['closed'])
  h.root.unmount()
})

// The zoom room spans the whole area under the toolbar's top, so a toolbar laid before it sat under its backdrop and every
// button press closed the preview. The toolbar is the later sibling: it paints over the image and takes the pointer first.
test('the toolbar sits above the zoomable image, so its buttons get their clicks', () => {
  const h = harness()
  h.render(<ImageViewer testId="viewer" src={image} label="icon.png" from={null} source={() => null} onClose={() => {}} />)
  const order = h.children.get(h.id('viewer'))!
  expect(order.indexOf(h.id('viewer-bar'))).toBeGreaterThan(order.indexOf(h.id('viewer-image')))
  expect(order.indexOf(h.id('viewer-image'))).toBeGreaterThan(order.indexOf(h.id('viewer-scrim')))
  h.root.unmount()
})

test('a close with the thumbnail gone shrinks and fades; Escape closes at once', () => {
  const h = harness()
  const from = { rect: { x: 40, y: 600, width: 64, height: 64 }, radius: 11, fit: 'cover' as const }
  const closed: string[] = []
  h.render(<ImageViewer testId="viewer" src={image} label="icon.png" from={from} source={() => null} onClose={() => closed.push('closed')} />)
  h.fire('viewer-close', { eventType: 'click' })
  expect(h.props('viewer-image').paintTransform.animate.opacity).toBe(0)
  h.root.unmount()

  const k = harness()
  k.render(<ImageViewer testId="viewer" src={image} label="icon.png" from={from} source={() => from} onClose={() => closed.push('escape')} />)
  k.fire('viewer', { eventType: 'keyDown', key: 'escape', modifiers: {} })
  expect(closed).toEqual(['escape'])
  k.root.unmount()
})

// ADE-70: a preview opened without a thumbnail (a work-row file chip, a link) and closed with X stayed mounted at
// opacity 0: its exit started from `initial: false`, never animated and never completed, so it took every click.
test('a preview opened without a thumbnail fades out from its shown values, lets clicks through and always unmounts', async () => {
  const h = harness()
  const closed: string[] = []
  h.render(<ImageViewer testId="viewer" src={image} label="icon.png" from={null} source={() => null} onClose={() => closed.push('closed')} />)
  h.fire('viewer-close', { eventType: 'click' })
  const exit = h.props('viewer-image').paintTransform
  expect(exit).toMatchObject({ initial: LANDED.outer, animate: { opacity: 0 } })
  expect(h.props('viewer-scrim').paintTransform).toMatchObject({ initial: { opacity: 1 }, animate: { opacity: 0 } })
  expect(h.style.get(h.id('viewer'))).toMatchObject({ pointerEvents: 'none' })
  expect(closed).toEqual([])
  // Even if the native layer never reports the exit, the preview goes away.
  await new Promise(resolve => setTimeout(resolve, exit.transition.duration * 1000 + 300))
  expect(closed).toEqual(['closed'])
  h.root.unmount()
})

// Review 2026-10-21: Tab left the open preview for the window behind it; it kept the size it opened with on a resize.
test('Tab and Shift-Tab wrap inside the open preview, and it follows window resizes', () => {
  const h = harness()
  h.render(<ImageViewer testId="viewer" src={image} label="icon.png" from={null} source={() => null} onClose={() => {}} />)
  const box = h.id('viewer')
  h.fire('viewer', { eventType: 'keyDown', key: 'tab', modifiers: {} })
  h.fire('viewer', { eventType: 'keyDown', key: 'tab', modifiers: { shift: true } })
  expect(h.moves).toEqual([`next:${box}`, `previous:${box}`])
  expect(h.style.get(box)).toMatchObject({ width: 1200, height: 800 })
  h.resize({ width: 900, height: 640, scaleFactor: 2, frame: 1 })
  expect(h.style.get(box)).toMatchObject({ width: 900, height: 640 })
  // A keyboard open is instant: nothing on the image moves.
  expect(h.props('viewer-image').paintTransform ?? undefined).toBeUndefined()
  h.root.unmount()
})

// ADE-55 follow-up: the preview zooms. A tall screenshot sheet used to open as a sliver.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'


function pngOfSize(width: number, height: number) {
  const bytes = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20)
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'zoom-')), `${width}x${height}.png`)
  writeFileSync(file, bytes)
  return file
}

test('a very tall image fills the room fitted to its width; a normal one keeps its old rect', () => {
  const tall = lightboxLayout(WINDOW, { width: 3240, height: 6432 })
  expect(tall.long).toBe(true)
  expect(tall.rect).toEqual(tall.area)
  expect(tall.area).toMatchObject({ width: 1000, y: 104 })
  const normal = lightboxLayout(WINDOW, { width: 256, height: 256 })
  expect(normal.long).toBe(false)
  expect(normal.rect).toEqual(lightboxRect(WINDOW, { width: 256, height: 256 }))
  // The room ends 48 px above the window's bottom edge, as the old rect did for a full-height image.
  expect(lightboxRect(WINDOW, { width: 10, height: 100000 }).y + lightboxRect(WINDOW, { width: 10, height: 100000 }).height).toBe(tall.area.y + tall.area.height)
})

test('a tall image opens without a morph, at the top; scroll pans, ⌘-scroll zooms, a double click toggles 100%, ⌘0 fits', () => {
  const h = harness()
  const from = { rect: { x: 40, y: 600, width: 64, height: 64 }, radius: 11, fit: 'cover' as const }
  h.render(<ImageViewer testId="viewer" src={pngOfSize(1620, 3240)} label="sheet.png" from={from} source={() => from} onClose={() => {}} />)
  // A fade, not a morph: the thumbnail only matches the whole picture.
  expect(h.props('viewer-image').paintTransform).toMatchObject({ initial: { opacity: 0 }, animate: { opacity: 1 } })
  const stage = () => h.props('viewer-zoom-surface-stage').paintTransform.animate
  expect(stage()).toMatchObject({ scale: 1, translateX: 0, translateY: 0 })
  h.fire('viewer-zoom-surface', { eventType: 'scroll', x: 600, y: 300, deltaX: 0, deltaY: -200, precise: true, modifiers: {} })
  expect(stage().translateY).toBe(-200)
  h.fire('viewer-zoom-surface', { eventType: 'scroll', x: 600, y: 300, deltaX: 0, deltaY: 40, precise: true, modifiers: { cmd: true } })
  expect(stage().scale).toBeGreaterThan(1)
  h.fire('viewer', { eventType: 'keyDown', key: '0', modifiers: { cmd: true } })
  expect(stage()).toMatchObject({ scale: 1, translateY: 0 })
  // Reduce Motion is off here: a discrete change eases; a wheel step does not.
  h.fire('viewer-zoom-surface', { eventType: 'click', x: 600, y: 300, button: 0, clickCount: 2 })
  expect(h.props('viewer-zoom-surface-stage').paintTransform.transition.duration).toBeGreaterThan(0)
  h.fire('viewer-zoom-surface', { eventType: 'scroll', x: 600, y: 300, deltaX: 0, deltaY: -10, precise: true, modifiers: {} })
  expect(h.props('viewer-zoom-surface-stage').paintTransform.transition.duration).toBe(0)
  h.root.unmount()
})

// Review 2026-10-23: Escape closed the preview and then bubbled on (GPUIX bubbles a keystroke through every ancestor and then
// the window handlers unless a handler stops it). An empty composer's window handler cancels the agent's turn on Escape while a
// request is pending, and the preview hands focus back to that composer as it closes.
test('Escape closes the preview and stops there; zoom keys stop there too; other keys bubble on', () => {
  const h = harness()
  const closed: string[] = [], outer: string[] = []
  h.render(<div testId="card" onKeyDown={(e: { key?: string }) => outer.push(e.key ?? '')}>
    <ImageViewer testId="viewer" src={pngOfSize(1620, 3240)} label="sheet.png" from={null} source={() => null} onClose={() => closed.push('closed')} />
  </div>)
  // Native sends one keystroke to the focused element, then to each ancestor, sharing its id.
  const press = (key: string, keystrokeId: number, modifiers = {}) => {
    h.fire('viewer', { eventType: 'keyDown', key, modifiers, keystrokeId })
    h.fire('card', { eventType: 'keyDown', key, modifiers, keystrokeId })
  }
  press('=', 1, { cmd: true })
  expect(h.props('viewer-zoom-surface-stage').paintTransform.animate.scale).toBeGreaterThan(1)
  press('a', 2)
  expect(outer).toEqual(['a'])
  // Zoomed in, Escape still closes (Quick Look's rule; ⌘0 is the way back to fit) and the card never hears it.
  press('escape', 3)
  expect(closed).toEqual(['closed'])
  expect(outer).toEqual(['a'])
  h.root.unmount()
})
