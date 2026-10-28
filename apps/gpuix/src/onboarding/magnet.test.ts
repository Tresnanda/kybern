import { describe, expect, test } from 'bun:test'
import { distanceOutside, magnetSupported, magnetTarget, MAX_DRIFT, REACH, springStep } from './magnet.ts'

const button = { x: 100, y: 100, width: 160, height: 44 }

describe('magnet reach', () => {
  test('inside the button is distance 0, outside is the straight distance to its edge', () => {
    expect(distanceOutside(button, 150, 120)).toBe(0)
    expect(distanceOutside(button, 90, 120)).toBe(10)
    expect(distanceOutside(button, 270, 120)).toBe(10)
    expect(distanceOutside(button, 90, 90)).toBeCloseTo(Math.hypot(10, 10))
  })
  test('rests beyond 24 px, drifts within it', () => {
    expect(magnetTarget(button, 100 - REACH - 1, 122)).toEqual({ x: 0, y: 0 })
    expect(magnetTarget(button, null, null)).toEqual({ x: 0, y: 0 })
    expect(magnetTarget(button, 100 - REACH, 122).x).not.toBe(0)
  })
})

describe('magnet drift', () => {
  test('x × 0.12 and y × 0.2 from the button’s centre', () => {
    const cx = 180, cy = 122
    expect(magnetTarget(button, cx + 20, cy + 10)).toEqual({ x: 20 * 0.12, y: 10 * 0.2 })
  })
  test('leans toward the pointer: left of centre drifts left, above drifts up', () => {
    const t = magnetTarget(button, 120, 105)
    expect(t.x).toBeLessThan(0)
    expect(t.y).toBeLessThan(0)
  })
  test('never more than 6 × 4 px', () => {
    const far = magnetTarget(button, 100 + 160 + REACH, 100)
    expect(Math.abs(far.x)).toBeLessThanOrEqual(MAX_DRIFT.x)
    expect(Math.abs(far.y)).toBeLessThanOrEqual(MAX_DRIFT.y)
    expect(far.x).toBe(MAX_DRIFT.x)
    expect(far.y).toBe(-MAX_DRIFT.y)
  })
})

describe('magnet spring', () => {
  const settle = (from: number, to: number) => {
    let value = from, velocity = 0, steps = 0, peak = from
    while (steps < 600 && (Math.abs(value - to) > 0.02 || Math.abs(velocity) > 0.05)) { [value, velocity] = springStep(value, velocity, to, 1 / 60); peak = Math.max(peak, value); steps++ }
    return { value, steps, peak }
  }
  test('critically damped: arrives without overshoot, in under a second', () => {
    const { steps, peak } = settle(0, 6)
    expect(peak).toBeLessThanOrEqual(6.02)
    expect(steps).toBeLessThan(60)
  })
  test('retargets from where it is, carrying its velocity', () => {
    let [value, velocity] = springStep(0, 0, 6, 1 / 60)
    ;[value, velocity] = springStep(value, velocity, -6, 1 / 60)
    expect(velocity).toBeGreaterThan(-100)
    expect(Number.isFinite(value)).toBe(true)
  })
})

describe('when the magnet is off', () => {
  const renderer = { setSubtreeTranslation() {} }
  test('on with motion, the patched addon and a renderer that can move a subtree', () => expect(magnetSupported(renderer, false, true)).toBe(true))
  test('off under Reduce Motion', () => expect(magnetSupported(renderer, true, true)).toBe(false))
  test('off without the patched addon', () => expect(magnetSupported(renderer, false, false)).toBe(false))
  test('off when the renderer cannot move a subtree', () => expect(magnetSupported({}, false, true)).toBe(false))
})
