// The pure parts of the cross-platform check harness: reading `xwininfo`, colour tolerance and the painted-region assertions.
import { expect, test } from 'bun:test'
import { assertPainted, near, parseXwininfoTree, type Png } from './check-harness.ts'

const TREE = `
xwininfo: Window id: 0x46 (the root window) (has no name)

  Root window id: 0x46 (the root window) (has no name)
  Parent window id: 0x0 (none)
     4 children:
     0x400008 "Rounded overflow capability": ("bun" "Bun")  760x820+340+40  +340+40
        1 child:
        0x400009 (has no name): ()  760x820+0+0  +340+40
     0x400004 (has no name): ()  10x10+-20+-20  +-20+-20
     0x400002 (has no name): ()  1x1+-1+-1  +-1+-1
     0x400001 "Xvfb helper": ("x" "X")  400x300+0+0  +0+0
`

test('xwininfo: the root children that are big enough, largest first, never their children', () => {
  const windows = parseXwininfoTree(TREE)
  expect(windows.map(w => w.id)).toEqual(['0x400008', '0x400001'])
  expect(windows[0]).toEqual({ id: '0x400008', width: 760, height: 820, x: 340, y: 40 })
})
test('xwininfo: nothing visible yields no windows (the harness then captures the root)', () => {
  expect(parseXwininfoTree('xwininfo: Window id: 0x46 (the root window) (has no name)\n')).toEqual([])
})
test('near: every channel within the tolerance', () => {
  expect(near([10, 20, 30], [13, 17, 30], 3)).toBe(true)
  expect(near([10, 20, 30], [14, 20, 30], 3)).toBe(false)
})

const image = (width: number, height: number, paint: (x: number, y: number) => number[]): Png => ({ width, height, at: (x, y) => paint(Math.floor(x), Math.floor(y)) })
test('assertPainted: a flat region fails, text-like content passes, and the scale maps logical px', () => {
  const flat = image(200, 200, () => [30, 30, 30])
  expect(() => assertPainted(flat, 1, { x: 10, y: 10, width: 100, height: 100 }, 'flat')).toThrow('expected painted content')
  const text = image(200, 200, (x, y) => (x % 8 < 3 && y % 8 < 3 ? [240, 240, 240] : [30, 30, 30]))
  assertPainted(text, 1, { x: 10, y: 10, width: 100, height: 100 }, 'text')
  const retina = image(400, 400, (x, y) => (x >= 100 && x < 200 && y >= 100 && y < 200 ? [200, 0, 0] : [30, 30, 30]))
  assertPainted(retina, 2, { x: 40, y: 40, width: 80, height: 80 }, 'retina', 12)
})
