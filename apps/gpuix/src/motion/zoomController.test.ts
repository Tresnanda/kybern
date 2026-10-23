import { expect, test } from 'bun:test'
import { ZoomController, type ZoomConfig } from './zoomController.ts'

const config = (over: Partial<ZoomConfig> = {}): ZoomConfig => ({ image: { width: 3240, height: 2594 }, viewport: { width: 1000, height: 700 }, origin: { x: 100, y: 50 }, scaleFactor: 2, reduced: false, ...over })
const make = (over: Partial<ZoomConfig> = {}) => { const c = new ZoomController(); c.configure(config(over)); return c }

test('a snapshot is stable until something changes, and the fitted view paints the identity transform', () => {
  const c = make()
  const first = c.snapshot()
  expect(c.snapshot()).toBe(first)
  expect(first).toMatchObject({ enabled: true, fitted: true, zoomed: false, percent: 54, transform: { scale: 1, translateX: 0, translateY: 0 } })
  expect(first.stage.width).toBeCloseTo(3240 * (700 / 2594))
  c.step(1)
  expect(c.snapshot()).not.toBe(first)
})

test('a double click toggles to actual pixels about the click and back to fit', () => {
  const c = make()
  // The click is at window (400, 250) = viewport (300, 200). The image point under it stays under it.
  const before = c.snapshot()
  const point = { x: (300 - before.view.x) / before.view.z, y: (200 - before.view.y) / before.view.z }
  expect(c.click(400, 250, 2)).toBe('toggled')
  const zoomed = c.snapshot()
  expect(zoomed.actual).toBe(true)
  expect(zoomed.percent).toBe(100)
  expect(zoomed.duration).toBeGreaterThan(0)
  expect((300 - zoomed.view.x) / zoomed.view.z).toBeCloseTo(point.x)
  expect((200 - zoomed.view.y) / zoomed.view.z).toBeCloseTo(point.y)
  expect(c.click(400, 250, 2)).toBe('toggled')
  expect(c.snapshot().fitted).toBe(true)
})

test('two quick clicks in one place are a double click even when the platform reports a count of 1', () => {
  const c = make()
  expect(c.click(400, 250, 1, 1000)).toBe('image')
  expect(c.click(402, 251, 1, 1200)).toBe('toggled')
  expect(c.snapshot().actual).toBe(true)
  // Slow, or far apart: two single clicks.
  expect(c.click(400, 250, 1, 5000)).toBe('image')
  expect(c.click(400, 250, 1, 5600)).toBe('image')
  expect(c.click(500, 250, 1, 5700)).toBe('image')
})

test('a single click on the letterbox is the backdrop; on the picture it is nothing', () => {
  const c = make()
  expect(c.click(100 + 5, 50 + 300, 1)).toBe('outside')
  expect(c.click(100 + 500, 50 + 300, 1)).toBe('image')
})

test('⌘-scroll zooms about the pointer in direct (unanimated) steps, within the range', () => {
  const c = make()
  c.wheel({ x: 600, y: 300, deltaX: 0, deltaY: 40, precise: true, modifiers: { cmd: true } })
  const one = c.snapshot()
  expect(one.view.z).toBeGreaterThan(c.snapshot().limits!.fit)
  expect(one.duration).toBe(0)
  expect(one.zoomed).toBe(true)
  for (let i = 0; i < 100; i++) c.wheel({ x: 600, y: 300, deltaX: 0, deltaY: 200, precise: true, modifiers: { cmd: true } })
  expect(c.snapshot().percent).toBe(800)
  for (let i = 0; i < 100; i++) c.wheel({ x: 600, y: 300, deltaX: 0, deltaY: -200, precise: true, modifiers: { cmd: true } })
  expect(c.snapshot().fitted).toBe(true)
  // Back at fit it follows the window again.
  c.configure(config({ viewport: { width: 600, height: 400 } }))
  expect(c.snapshot().stage.height).toBeCloseTo(400)
})

test('two-finger scroll pans only when zoomed, and stops at the edges', () => {
  const c = make()
  c.wheel({ x: 600, y: 300, deltaX: 30, deltaY: 30, precise: true })
  expect(c.snapshot().fitted).toBe(true)
  c.click(400, 250, 2)
  const start = c.snapshot().view
  c.wheel({ x: 600, y: 300, deltaX: 0, deltaY: -50, precise: true })
  expect(c.snapshot().view.y).toBeCloseTo(start.y - 50)
  for (let i = 0; i < 200; i++) c.wheel({ x: 600, y: 300, deltaX: -100, deltaY: -100, precise: true })
  expect(c.snapshot().view).toMatchObject({ x: 1000 - 3240 * 0.5, y: 700 - 2594 * 0.5 })
  for (let i = 0; i < 400; i++) c.wheel({ x: 600, y: 300, deltaX: 100, deltaY: 100, precise: true })
  expect(c.snapshot().view).toMatchObject({ x: 0, y: 0 })
})

test('dragging pans while the button is down and ends when it is released or the release was lost', () => {
  const c = make()
  c.click(400, 250, 2)
  const start = c.snapshot().view
  c.pointerDown(500, 300)
  expect(c.snapshot().dragging).toBe(true)
  c.pointerMove(480, 260, true)
  expect(c.snapshot().view).toMatchObject({ x: start.x - 20, y: start.y - 40 })
  c.pointerUp()
  expect(c.snapshot().dragging).toBe(false)
  c.pointerMove(300, 300, true)
  expect(c.snapshot().view.x).toBe(start.x - 20)
  // The mouse-up happened outside: the next move, with no button down, ends the drag.
  c.pointerDown(500, 300)
  c.pointerMove(500, 300, false)
  expect(c.snapshot().dragging).toBe(false)
})

test('⌘+ ⌘− ⌘0 step, step back and fit; other keys are left alone', () => {
  const c = make()
  expect(c.key({ key: '=', modifiers: { cmd: true } })).toBe(true)
  const zoomed = c.snapshot()
  expect(zoomed.view.z).toBeCloseTo(c.snapshot().limits!.fit * 1.25)
  expect(c.key({ key: '+', modifiers: { cmd: true, shift: true } })).toBe(true)
  expect(c.key({ key: '-', modifiers: { cmd: true } })).toBe(true)
  expect(c.key({ key: '0', modifiers: { cmd: true } })).toBe(true)
  expect(c.snapshot().fitted).toBe(true)
  expect(c.key({ key: '=', modifiers: {} })).toBe(false)
  expect(c.key({ key: 'a', modifiers: { cmd: true } })).toBe(false)
  expect(c.key({ key: '=', modifiers: { cmd: true, alt: true } })).toBe(false)
})

test('a keyboard zoom anchors at the pointer when it is over the viewport, else the middle', () => {
  const c = make()
  c.hover(100 + 500, 50 + 100)
  const fit = c.snapshot().view
  const under = { x: (500 - fit.x) / fit.z, y: (100 - fit.y) / fit.z }
  c.key({ key: '=', modifiers: { cmd: true } })
  const zoomed = c.snapshot().view
  expect((500 - zoomed.x) / zoomed.z).toBeCloseTo(under.x)
  expect((100 - zoomed.y) / zoomed.z).toBeCloseTo(under.y)
  const d = make()
  d.hover(5000, 5000)
  d.key({ key: '=', modifiers: { cmd: true } })
  const centre = d.snapshot().view
  expect((500 - centre.x) / centre.z).toBeCloseTo((500 - d.snapshot().stage.x) / d.snapshot().limits!.fit)
})

test('Reduce Motion never animates, and a tall image opens at its top fitted to its width', () => {
  const c = make({ reduced: true })
  c.click(400, 250, 2)
  expect(c.snapshot().duration).toBe(0)
  const tall = make({ image: { width: 1620, height: 3240 } })
  expect(tall.snapshot()).toMatchObject({ fitted: true, view: { x: 0, y: 0 } })
  expect(tall.snapshot().limits!.axis).toBe('width')
  expect(tall.snapshot().stage.width).toBe(1000)
  // It scrolls along the long axis with the two-finger scroll even at fit.
  tall.wheel({ x: 500, y: 300, deltaX: 0, deltaY: -200, precise: true })
  expect(tall.snapshot().view.y).toBe(-200)
  // Still at the fit zoom, so the HUD says Fit and nothing is zoomed.
  expect(tall.snapshot()).toMatchObject({ fitted: true, zoomed: false })
})

test('a tall image pans all the way to its bottom edge at fit and at 100%', () => {
  // The reported sheet (2720 × 7014) in a 1000 × 634 room on a Retina screen. The transform must carry the image's bottom
  // to the viewport's bottom; the cut-off picture was the native clip moving with the pan, not the pan stopping short.
  const viewport = { width: 1000, height: 634 }
  const c = make({ image: { width: 2720, height: 7014 }, viewport })
  const bottom = () => { const s = c.snapshot(); return s.stage.y + s.transform.translateY + s.stage.height * s.transform.scale }
  for (let i = 0; i < 40; i++) c.wheel({ x: 600, y: 400, deltaX: 0, deltaY: -200, precise: true })
  expect(c.snapshot().fitted).toBe(true)
  expect(bottom()).toBeCloseTo(viewport.height)
  c.zoomTo(c.snapshot().limits!.actual, undefined, false)
  for (let i = 0; i < 60; i++) c.wheel({ x: 600, y: 400, deltaX: 0, deltaY: -200, precise: true })
  expect(c.snapshot().actual).toBe(true)
  expect(bottom()).toBeCloseTo(viewport.height)
})

test('an image of unknown size does not zoom', () => {
  const c = make({ image: null })
  expect(c.snapshot().enabled).toBe(false)
  expect(c.key({ key: '=', modifiers: { cmd: true } })).toBe(false)
  expect(c.click(400, 250, 2)).toBeNull()
})

// Review 2026-10-23: the click that ends a drag landed on the letterbox and closed the lightbox mid-pan.
test('the click that ends a drag is not a click: no backdrop close, no double-click toggle', () => {
  const c = make()
  c.click(400, 250, 2)
  // Press on the picture, pan, release over the letterbox (left of the picture after the pan).
  c.pointerDown(500, 300)
  c.pointerMove(560, 320, true)
  c.pointerUp()
  expect(c.click(105, 350, 1)).toBeNull()
  // A press that barely moves is still a click, and the next press starts afresh.
  c.pointerDown(105, 350)
  c.pointerMove(107, 351, true)
  c.pointerUp()
  expect(c.click(107, 351, 1, 10_000)).not.toBeNull()
  c.pointerDown(600, 300)
  c.pointerUp()
  expect(c.click(600, 300, 1, 20_000)).toBe('image')
})

test('zoom stays anchored under the pointer, clamps at both ends, and keeps a small image centred', () => {
  const c = make()
  const before = c.snapshot().view, at = { x: 300, y: 200 }
  const under = { x: (at.x - before.x) / before.z, y: (at.y - before.y) / before.z }
  c.wheel({ x: 100 + at.x, y: 50 + at.y, deltaX: 0, deltaY: 30, precise: true, modifiers: { cmd: true } })
  const after = c.snapshot().view
  expect((at.x - after.x) / after.z).toBeCloseTo(under.x)
  expect((at.y - after.y) / after.z).toBeCloseTo(under.y)
  // Zoomed past the viewport, the picture always covers it: it can never be dragged off screen.
  for (let i = 0; i < 20; i++) c.wheel({ x: 600, y: 300, deltaX: 0, deltaY: 200, precise: true, modifiers: { cmd: true } })
  c.pointerDown(500, 300); c.pointerMove(-20_000, -20_000, true); c.pointerUp()
  const far = c.snapshot().view
  expect(far.x + 3240 * far.z).toBeGreaterThanOrEqual(1000 - 1e-6)
  expect(far.y + 2594 * far.z).toBeGreaterThanOrEqual(700 - 1e-6)
  // A small image never zooms out below 100% or its fit, and stays centred whatever the drag.
  const small = make({ image: { width: 200, height: 100 } })
  for (let i = 0; i < 20; i++) small.wheel({ x: 600, y: 300, deltaX: 0, deltaY: -200, precise: true, modifiers: { cmd: true } })
  const s = small.snapshot()
  expect(s.view.z).toBeCloseTo(s.limits!.min)
  small.pointerDown(500, 300); small.pointerMove(900, 600, true); small.pointerUp()
  expect(small.snapshot().view.x + 100 * small.snapshot().view.z).toBeCloseTo(500)
  expect(small.snapshot().view.y + 50 * small.snapshot().view.z).toBeCloseTo(350)
})

test('a window resize while zoomed keeps the zoom and clamps the picture to the new viewport', () => {
  const c = make()
  c.click(400, 250, 2)
  for (let i = 0; i < 50; i++) c.wheel({ x: 600, y: 300, deltaX: -100, deltaY: -100, precise: true })
  const z = c.snapshot().view.z
  c.configure(config({ viewport: { width: 1400, height: 900 } }))
  const view = c.snapshot().view
  expect(view.z).toBe(z)
  expect(view.x + 3240 * z).toBeGreaterThanOrEqual(1400 - 1e-6)
  expect(view.y + 2594 * z).toBeGreaterThanOrEqual(900 - 1e-6)
})
