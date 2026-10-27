import { describe, expect, test } from 'bun:test'
import { BLUR_MAX } from '../platform/translucency.ts'
import {
  arrowTarget, cardHeight, cardX, contentPatch, glideSteps, labelLines, modeRowHeight, modeY, prefsLayout, splitStop, warningHeight, warningLines, type SliderValues,
} from './prefsLayout.ts'

describe('prefsLayout', () => {
  test('two columns at 1.15 : 1 with a 40 gap, capped at 1060', () => {
    const l = prefsLayout(1600)
    expect(l.two).toBe(true)
    expect(l.width).toBe(1060)
    expect(l.left + l.right + 40).toBe(1060)
    expect(l.left / l.right).toBeGreaterThan(1.14)
    expect(l.left / l.right).toBeLessThan(1.16)
  })
  test('one column under 880 px of window', () => {
    const l = prefsLayout(879)
    expect(l.two).toBe(false)
    expect(l.left).toBe(l.width)
    expect(l.right).toBe(l.width)
    expect(prefsLayout(880).two).toBe(true)
  })
  test('cards fit their column exactly and the preview is 16:10', () => {
    for (const w of [900, 1100, 1440, 2000, 700]) {
      const l = prefsLayout(w)
      expect(l.card * 3 + 20).toBeLessThanOrEqual(l.left)
      expect(l.left - (l.card * 3 + 20)).toBeLessThan(3)
      expect(Math.abs(l.preview.width / l.preview.height - 1.6)).toBeLessThan(0.05)
    }
  })
  test('the ring sits on the card it selects', () => {
    expect(cardX(0, 175)).toBe(0)
    expect(cardX(2, 175)).toBe(2 * 185)
    expect(cardHeight(100, 1)).toBeLessThan(cardHeight(100, 2))
  })
  test('a narrow card gives the long label two lines', () => {
    expect(labelLines(175, ['Solid', 'Translucent sidebar', 'Full translucency'])).toBe(1)
    expect(labelLines(120, ['Solid', 'Translucent sidebar', 'Full translucency'])).toBe(2)
  })
  test('permission rows grow when the column is narrow, and the highlight steps by row', () => {
    expect(modeRowHeight(480)).toBe(60)
    expect(modeRowHeight(340)).toBe(78)
    expect(modeY(3, 60)).toBe(180)
  })
  test('the warning takes more lines in a narrow column', () => {
    expect(warningLines(300, 100)).toBeGreaterThan(warningLines(560, 100))
    expect(warningHeight(2)).toBe(46)
  })
})

describe('glideSteps', () => {
  const from: SliderValues = { sidebar: 90, content: 100, elements: 55, blur: 100 }
  const to: SliderValues = { sidebar: 85, content: 85, elements: 60, blur: 100 }
  test('ends exactly on the target, at most 12 steps, eased out', () => {
    const steps = glideSteps(from, to, 10)
    expect(steps.length).toBeLessThanOrEqual(10)
    expect(steps[steps.length - 1]).toEqual(to)
    expect(steps[0]!.content).toBeLessThan(100)
    expect(steps[0]!.content).toBeGreaterThan(to.content)
    // Eased out: the first step covers more than the last one.
    const travel = steps.map((s, i) => Math.abs(s.content - (i ? steps[i - 1]!.content : from.content)))
    expect(travel[0]!).toBeGreaterThanOrEqual(travel[travel.length - 1]!)
    expect(glideSteps(from, to, 99).length).toBeLessThanOrEqual(12)
  })
  test('nothing to move is one frame on the target', () => {
    expect(glideSteps(to, to, 10)).toEqual([to])
  })
})

describe('contentPatch', () => {
  test('below 100 is whole-window translucency, 100 is sidebar only', () => {
    expect(contentPatch(85, 'darwin')).toEqual({ material: 'translucent', contentOpacity: 85 })
    expect(contentPatch(100, 'darwin')).toEqual({ material: 'translucent', contentOpacity: 100 })
  })
  test('on Windows the whole window is Acrylic (a number) and the sidebar alone keeps Mica (null)', () => {
    expect(contentPatch(85, 'win32').blur).toBe(BLUR_MAX)
    expect(contentPatch(100, 'win32').blur).toBeNull()
  })
})

describe('splitStop', () => {
  test('a box that is the whole miniature splits in the middle', () => {
    expect(splitStop({ width: 160, height: 100 }, { x: 0, y: 0, width: 160, height: 100 })).toBeCloseTo(0.5, 6)
  })
  test('the diagonal leans left lower down: the same box sits further right of the boundary, so its stop moves toward 0', () => {
    const low = splitStop({ width: 160, height: 100 }, { x: 40, y: 76, width: 100, height: 16 })
    const high = splitStop({ width: 160, height: 100 }, { x: 40, y: 8, width: 100, height: 16 })
    expect(low).toBeLessThan(high)
    expect(low).toBeLessThan(0.5)
  })
})

describe('arrowTarget', () => {
  test('arrows wrap in a group and other keys do nothing', () => {
    expect(arrowTarget('right', 2, 3)).toBe(0)
    expect(arrowTarget('left', 0, 3)).toBe(2)
    expect(arrowTarget('down', 1, 4, 'column')).toBe(2)
    expect(arrowTarget('right', 1, 4, 'column')).toBeNull()
    expect(arrowTarget('up', 1, 3, 'row')).toBeNull()
    expect(arrowTarget('a', 1, 3)).toBeNull()
  })
})
