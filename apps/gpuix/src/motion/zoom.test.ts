import { expect, test } from 'bun:test'
import { clampAxis, EXTREME, fitView, isActual, isFit, limits, MAX_ACTUAL, panBy, percent, resolveView, stepZoom, toggleZoom, wheelFactor, zoomAt } from './zoom.ts'

const viewport = { width: 1000, height: 700 }

test('a normal image fits the viewport, never upscaled, centred', () => {
  const lim = limits({ width: 3240, height: 2594 }, viewport, 2)
  expect(lim.axis).toBe('contain')
  expect(lim.fit).toBeCloseTo(700 / 2594)
  const view = fitView({ width: 3240, height: 2594 }, viewport, lim)
  expect(view.y).toBe(0)
  expect(view.x).toBeCloseTo((1000 - 3240 * lim.fit) / 2)
  // A small image keeps its size and sits in the middle.
  const small = limits({ width: 200, height: 100 }, viewport)
  expect(small.fit).toBe(1)
  expect(fitView({ width: 200, height: 100 }, viewport, small)).toEqual({ z: 1, x: 400, y: 300 })
})

test('a very tall image fits its width and opens at the top; a very wide one fits its height and opens at the left', () => {
  const tall = { width: 1620, height: 3240 }
  const lt = limits(tall, viewport, 2)
  expect(lt.axis).toBe('width')
  expect(lt.fit).toBeCloseTo(1000 / 1620)
  expect(fitView(tall, viewport, lt)).toMatchObject({ x: 0, y: 0 })
  const wide = { width: 4000, height: 600 }
  const lw = limits(wide, viewport, 2)
  expect(lw.axis).toBe('height')
  expect(lw.fit).toBeCloseTo(700 / 600 > 1 ? 1 : 700 / 600)
  // The threshold is 1.6 times the viewport's own aspect.
  const edge = { width: Math.round(700 * (1000 / 700) / EXTREME) - 1, height: 700 }
  expect(limits(edge, viewport).axis).toBe('width')
  expect(limits({ width: edge.width + 40, height: 700 }, viewport).axis).toBe('contain')
})

test('100% is actual device pixels and the range runs from fit to 800%', () => {
  const image = { width: 3240, height: 2594 }
  const lim = limits(image, viewport, 2)
  expect(lim.actual).toBe(0.5)
  expect(lim.max).toBe(0.5 * MAX_ACTUAL)
  expect(percent({ z: 0.5, x: 0, y: 0 }, lim)).toBe(100)
  expect(percent(fitView(image, viewport, lim), lim)).toBe(54)
  // An image smaller than 100%'s fit can still be viewed at 100%.
  const tiny = limits({ width: 300, height: 200 }, viewport, 2)
  expect(tiny.min).toBe(0.5)
  expect(tiny.fit).toBe(1)
})

test('zooming keeps the point under the pointer still', () => {
  const image = { width: 3240, height: 2594 }
  const lim = limits(image, viewport, 2)
  const start = fitView(image, viewport, lim)
  const anchor = { x: 600, y: 200 }
  // The image pixel under the anchor before and after.
  const before = { x: (anchor.x - start.x) / start.z, y: (anchor.y - start.y) / start.z }
  const next = zoomAt(start, 0.5, anchor, image, viewport, lim)
  expect(next.z).toBe(0.5)
  expect((anchor.x - next.x) / next.z).toBeCloseTo(before.x)
  expect((anchor.y - next.y) / next.z).toBeCloseTo(before.y)
})

test('a zoomed view stays inside the image edges, and an axis smaller than the viewport is centred', () => {
  const image = { width: 3240, height: 2594 }
  const lim = limits(image, viewport, 2)
  const zoomed = zoomAt(fitView(image, viewport, lim), 1, { x: 0, y: 0 }, image, viewport, lim)
  // Panning far right/down cannot pull the corner away, and far left/up stops at the opposite edge.
  expect(panBy(zoomed, 99999, 99999, image, viewport, lim)).toMatchObject({ x: 0, y: 0 })
  const far = panBy(zoomed, -99999, -99999, image, viewport, lim)
  expect(far.x).toBe(1000 - 3240)
  expect(far.y).toBe(700 - 2594)
  // Zoom out past the viewport size: centred again.
  expect(clampAxis(-50, 400, 1000)).toBe(300)
  expect(clampAxis(-50, 1400, 1000)).toBe(-50)
  expect(clampAxis(50, 1400, 1000)).toBe(0)
  expect(clampAxis(-900, 1400, 1000)).toBe(-400)
})

test('zoom is clamped to the range', () => {
  const image = { width: 3240, height: 2594 }
  const lim = limits(image, viewport, 2)
  const view = fitView(image, viewport, lim)
  expect(zoomAt(view, 100, { x: 500, y: 350 }, image, viewport, lim).z).toBe(lim.max)
  expect(zoomAt(view, 0.0001, { x: 500, y: 350 }, image, viewport, lim).z).toBe(lim.min)
})

test('steps land exactly on 100% and on fit when they would cross them', () => {
  const lim = limits({ width: 3240, height: 2594 }, viewport, 2)
  // fit is 0.27, actual 0.5: one step from fit is 0.3375, a second 0.42, a third crosses 0.5.
  let z = lim.fit
  const seen: number[] = []
  for (let i = 0; i < 4; i++) { z = stepZoom(z, 1, lim); seen.push(z) }
  expect(seen).toContain(lim.actual)
  expect(seen.indexOf(lim.actual)).toBe(2)
  // Out again from beyond 100% stops at 100%, then at fit.
  expect(stepZoom(0.55, -1, lim)).toBe(lim.actual)
  expect(stepZoom(0.3, -1, lim)).toBe(lim.fit)
  // The ends hold.
  expect(stepZoom(lim.fit, -1, lim)).toBe(lim.fit)
  expect(stepZoom(lim.max, 1, lim)).toBe(lim.max)
})

test('the toggle goes to actual pixels and back to fit', () => {
  const image = { width: 3240, height: 2594 }
  const lim = limits(image, viewport, 2)
  const fit = fitView(image, viewport, lim)
  expect(isFit(fit, lim)).toBe(true)
  expect(toggleZoom(fit, lim)).toBe(lim.actual)
  const actual = zoomAt(fit, lim.actual, { x: 500, y: 350 }, image, viewport, lim)
  expect(isActual(actual, lim)).toBe(true)
  expect(toggleZoom(actual, lim)).toBe(lim.fit)
  // From somewhere in between it goes to actual pixels.
  expect(toggleZoom({ z: 0.4, x: 0, y: 0 }, lim)).toBe(lim.actual)
})

test('a fitted view follows a window resize; a free one keeps its zoom and re-clamps', () => {
  const image = { width: 3240, height: 2594 }
  const small = { width: 600, height: 400 }
  const limSmall = limits(image, small, 2)
  expect(resolveView(null, image, small, limSmall).z).toBeCloseTo(400 / 2594)
  const free = { z: 0.5, x: -800, y: -900 }
  const resolved = resolveView(free, image, small, limSmall)
  expect(resolved.z).toBe(0.5)
  expect(resolved.x).toBe(-800)
  expect(resolved.y).toBe(-897)
  expect(resolveView({ z: 0.5, x: -99999, y: -99999 }, image, small, limSmall)).toMatchObject({ x: 600 - 1620, y: 400 - 1297 })
})

test('wheel zoom: scrolling one way zooms in, the other out, in bounded steps', () => {
  expect(wheelFactor(-10, true)).toBeGreaterThan(1)
  expect(wheelFactor(10, true)).toBeLessThan(1)
  expect(wheelFactor(-10000, true)).toBe(2)
  expect(wheelFactor(10000, true)).toBe(0.5)
  expect(wheelFactor(-1, false)).toBeGreaterThan(wheelFactor(-1, true))
})
