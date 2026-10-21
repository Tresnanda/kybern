import { expect, mock, test } from 'bun:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import type { ReactNode } from 'react'

mock.module('../native/visibility.ts', () => ({ isWindowVisible: () => true, onWindowVisibility: () => () => {} }))
mock.module('../native/local-build.ts', () => ({ PATCHED_NATIVE: true }))
const { fallbackTo, ImageViewer, LANDED, lightboxRect, morphFrom, onScreen, MORPH_OPEN, MORPH_CLOSE } = await import('./ImageMorph.tsx')
const { ThemeProvider } = await import('../ui.tsx')
const entry = createRequire(import.meta.url).resolve('@gpuix/react')
const { createRoot, flushSync } = await import(pathToFileURL(path.join(path.dirname(entry), 'reconciler/reconciler.js')).href)
const { handleGpuixEvent } = await import(pathToFileURL(path.join(path.dirname(entry), 'reconciler/event-registry.js')).href)

const image = new URL('../../../desktop/src-tauri/icons/128x128@2x.png', import.meta.url).pathname
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
  const custom = new Map<number, Record<string, any>>(), style = new Map<number, Record<string, any>>(), moves: string[] = []
  let resized: ((error: Error | null, event: unknown) => void) | undefined
  const renderer = {
    applyBatch(json: string) {
      for (const [op, id, a, b] of JSON.parse(json) as [string, number, any, any][]) {
        if (op === 'createElement') custom.set(id, {})
        else if (op === 'setCustomProp') custom.get(id)![a] = b
        else if (op === 'setStyle') style.set(id, a)
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
  return { root, render, id, props, fire, style, moves, resize: (event: unknown) => flushSync(() => resized!(null, event)), custom }
}

test('a pointer open morphs from the thumbnail and a pointer close returns into where it is now', () => {
  const h = harness()
  const from = { rect: { x: 40, y: 600, width: 64, height: 64 }, radius: 11, fit: 'cover' as const }
  let now: typeof from | null = from
  const closed: string[] = []
  h.render(<ImageViewer testId="viewer" src={image} label="icon.png" from={from} source={() => now} onClose={() => closed.push('closed')} />)
  const rect = lightboxRect(WINDOW, { width: 256, height: 256 })
  const start = morphFrom(from, rect, true)
  const outer = h.props('viewer-image').paintTransform, inner = [...h.custom.values()].find(p => p.paintTransform?.animate?.clipRadius !== undefined)!.paintTransform
  expect(outer).toMatchObject({ initial: start.outer, animate: LANDED.outer, transition: MORPH_OPEN })
  expect(inner).toMatchObject({ initial: start.inner, animate: LANDED.inner, transition: MORPH_OPEN })
  // The toolbar arrives as the image lands.
  expect(h.props('viewer-bar').paintTransform.transition.delay).toBeCloseTo(MORPH_OPEN.duration * 0.7)
  // The thumbnail moved while the preview was open; the close lands on its new rect, retargeting from the value on screen.
  now = { ...from, rect: { ...from.rect, y: 500 } }
  h.fire('viewer-scrim', { eventType: 'click' })
  const back = morphFrom(now, rect, true)
  const closing = h.props('viewer-image').paintTransform
  expect(closing).toMatchObject({ initial: false, animate: back.outer, transition: MORPH_CLOSE })
  expect(closed).toEqual([])
  h.fire('viewer-image', { eventType: 'motionComplete', motionGeneration: closing.generation })
  expect(closed).toEqual(['closed'])
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
