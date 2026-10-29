import { describe, expect, test } from 'bun:test'
import { containsPoint, submenuCorridor, submenuOverlapsParent } from './menuGeometry.ts'

const panel = { x: 200, y: 100, width: 190, height: 120 }
describe('submenu corridor', () => {
  test('inside the submenu is safe', () => expect(submenuCorridor({ x: 150, y: 120 }, panel, { x: 250, y: 150 })).toBe(true))
  test('a diagonal path from the trigger toward the submenu stays safe over sibling rows', () => {
    const origin = { x: 150, y: 110 }
    for (const [x, y] of [[160, 118], [170, 126], [180, 134], [190, 142], [199, 150]]) expect(submenuCorridor(origin, panel, { x: x!, y: y! })).toBe(true)
  })
  test('moving away vertically leaves the corridor', () => {
    const origin = { x: 150, y: 110 }
    expect(submenuCorridor(origin, panel, { x: 152, y: 260 })).toBe(false)
    expect(submenuCorridor(origin, panel, { x: 152, y: 40 })).toBe(false)
  })
  test('past the submenu edge or behind the origin is not the corridor', () => {
    expect(submenuCorridor({ x: 150, y: 110 }, panel, { x: 120, y: 112 })).toBe(false)
  })
  test('a submenu flipped to the left uses its right edge', () => {
    const left = { x: 20, y: 100, width: 100, height: 100 }
    const origin = { x: 150, y: 110 }
    expect(submenuCorridor(origin, left, { x: 140, y: 118 })).toBe(true)
    expect(submenuCorridor(origin, left, { x: 140, y: 260 })).toBe(false)
  })
  test('no origin means only the panel itself', () => {
    expect(submenuCorridor(null, panel, { x: 195, y: 150 })).toBe(false)
    expect(containsPoint(panel, { x: 195, y: 150 }, 6)).toBe(true)
  })
})

describe('submenu placement', () => {
  const row = { x: 1000, y: 300, width: 190, height: 26 }
  test('a popup right of the row fits', () => expect(submenuOverlapsParent({ x: 1190, y: 295, width: 192, height: 120 }, row)).toBe(false))
  test('a popup pushed back over the row’s menu opens on the left', () => expect(submenuOverlapsParent({ x: 1008, y: 295, width: 192, height: 120 }, row)).toBe(true))
  test('nothing measured yet keeps the right side', () => expect(submenuOverlapsParent(null, row)).toBe(false))
})
