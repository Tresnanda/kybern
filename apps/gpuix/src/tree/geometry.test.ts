import { describe, expect, test } from 'bun:test'
import { ELBOW, HAIRLINE, flatTree, treeSegments, type Segment, type TreeShape } from './geometry.ts'

const byKey = (segments: Segment[]) => Object.fromEntries(segments.map(s => [s.key, s]))
const node = (last: boolean, extra: Partial<TreeShape> = {}): TreeShape => ({ branch: { x: 44, joint: 'node', last, tickEnd: 55 }, anchor: 16, ...extra })

describe('treeSegments', () => {
  test('a middle child: one stem edge to edge, a tick on the icon centre line', () => {
    const s = byKey(treeSegments(node(false)))
    expect(Object.keys(s).sort()).toEqual(['stem', 'tee', 'tick'])
    // The stem: [x - line, x], from the row's top to the knee, then the tee from the knee to the bottom edge.
    expect(s.stem).toMatchObject({ left: 44 - HAIRLINE, top: 0, width: HAIRLINE, height: 16 - ELBOW })
    expect(s.tee).toMatchObject({ left: 44 - HAIRLINE, top: 16 - ELBOW, bottom: 0 })
    expect(s.stem!.top + s.stem!.height!).toBe(s.tee!.top)
    // The tick starts on the stem's right edge (no doubled pixel) and stops before the icon.
    expect(s.tick).toMatchObject({ left: 44, top: 16 - HAIRLINE, width: 11, height: HAIRLINE })
  })

  test('the last child ends the stem in a rounded elbow at the icon centre line', () => {
    const s = byKey(treeSegments(node(true)))
    expect(Object.keys(s).sort()).toEqual(['elbow', 'stem'])
    expect(s.elbow).toMatchObject({ left: 44 - HAIRLINE, top: 16 - ELBOW, height: ELBOW, corner: ELBOW, width: 55 - 44 + HAIRLINE })
    // Its bottom border lies on the same pixel row as a tee's tick.
    expect(s.elbow!.top + s.elbow!.height!).toBe(16)
    expect(s.stem!.top + s.stem!.height!).toBe(s.elbow!.top)
  })

  test('a chevron on the junction: the stem breaks around it, the tick runs on to the icon', () => {
    const mid = byKey(treeSegments({ branch: { x: 44, joint: 'toggle', last: false, tickEnd: 55 }, anchor: 17 }))
    expect(mid.stem!.height).toBe(17 - ELBOW)
    expect(mid.tee!.top).toBe(17 + ELBOW)
    expect(mid.tick).toMatchObject({ left: 44 + ELBOW, width: 55 - 44 - ELBOW })
    const last = byKey(treeSegments({ branch: { x: 44, joint: 'toggle', last: true, tickEnd: 55 }, anchor: 17 }))
    expect(last.tee).toBeUndefined()
  })

  test('prose passes: the stem runs past it, and nothing is drawn after the last child', () => {
    expect(byKey(treeSegments({ branch: { x: -14, joint: 'pass', last: false, tickEnd: -2 }, anchor: 16 })).stem).toMatchObject({ top: 0, bottom: 0 })
    expect(treeSegments({ branch: { x: -14, joint: 'pass', last: true, tickEnd: -2 }, anchor: 16 })).toEqual([])
  })

  test('depth 2: outer stems pass through as rails, the parent stem leaves under its icon', () => {
    const s = byKey(treeSegments({ ...node(false), rails: [24], below: { x: 64, from: 25 }, overlap: 2, top: -2 }))
    expect(s['rail:0']).toMatchObject({ left: 24 - HAIRLINE, top: -2, bottom: -2 })
    expect(s.below).toMatchObject({ left: 64 - HAIRLINE, top: 25, bottom: -2 })
    expect(s.stem!.top).toBe(-2)
    expect(byKey(treeSegments({ anchor: 16, below: { x: 8, from: 22, to: 24 } })).below).toMatchObject({ top: 22, height: 2 })
  })

  test('recycled rows paint the same pieces from the same props', () => {
    const shape = node(false, { rails: [24, 44] })
    expect(treeSegments({ ...shape })).toEqual(treeSegments(shape))
  })
})

describe('flatTree', () => {
  // 0 Parent · 1 a · 1 b · 2 b1 · 2 b2 · 1 c · 0 Next
  const depths = [0, 1, 1, 2, 2, 1, 0]
  const rows = flatTree(depths)

  test('last siblings end their stem', () => {
    expect(rows.map(r => r.last)).toEqual([false, false, false, false, true, true, true])
  })

  test('outer stems continue through deeper rows while a later sibling follows', () => {
    expect(rows[3]!.continues).toEqual([true])
    expect(rows[4]!.continues).toEqual([true])
    expect(flatTree([0, 1, 2, 2])[3]!.continues).toEqual([false])
  })

  test('open rows are followed by their children', () => {
    expect(rows.map(r => r.open)).toEqual([true, false, true, false, false, false, false])
  })

  test('stems tile across consecutive rows with no gap', () => {
    // Every row whose slice at a level runs to its bottom is followed by a row whose slice there starts at its top.
    const shapes = depths.map((depth, i): TreeShape => ({
      anchor: 16,
      rails: rows[i]!.continues.flatMap((on, level) => on ? [44 + 20 * level] : []),
      ...(depth > 0 ? { branch: { x: 44 + 20 * (depth - 1), joint: 'node' as const, last: rows[i]!.last, tickEnd: 35 + 20 * depth } } : {}),
      ...(rows[i]!.open ? { below: { x: 44 + 20 * depth, from: 25 } } : {}),
    }))
    for (let i = 0; i + 1 < shapes.length; i++) {
      const open = treeSegments(shapes[i]!).filter(s => s.bottom !== undefined).map(s => s.left)
      const next = treeSegments(shapes[i + 1]!).filter(s => s.top === 0).map(s => s.left)
      for (const left of open) expect(next).toContain(left)
    }
  })
})
