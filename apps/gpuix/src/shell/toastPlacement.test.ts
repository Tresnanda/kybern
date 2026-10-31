import { expect, test } from 'bun:test'
import { toastPosition } from './toastPlacement.ts'

const window = { width: 1200, height: 800 }
const card = { x: 300, y: 640, width: 800, height: 144 }

test('stays 16 px from the corner without a visible composer or without overlap', () => {
  const corner = { x: 1184, y: 784 }
  expect(toastPosition(window, 356, 54, [])).toEqual(corner)
  expect(toastPosition(window, 356, 54, [{ ...card, width: 528 }])).toEqual(corner)
  expect(toastPosition(window, 356, 54, [{ ...card, y: 500, height: 230 }])).toEqual(corner)
  expect(toastPosition(window, 356, 54, [{ ...card, height: 0 }])).toEqual(corner)
})

test('clears the actual composer top by 8 px and follows its growth', () => {
  expect(toastPosition(window, 356, 54, [card])).toEqual({ x: 1184, y: 632 })
  expect(toastPosition(window, 356, 54, [{ ...card, y: 550, height: 234 }])).toEqual({ x: 1184, y: 542 })
})

test('clears a right-edge composer in a narrow window', () => {
  expect(toastPosition({ width: 900, height: 700 }, 356, 54,
    [{ x: 260, y: 540, width: 624, height: 144 }])).toEqual({ x: 884, y: 532 })
})

test('uses the complete expanded stack height when a raised composer intersects an older toast', () => {
  const raised = { x: 900, y: 580, width: 280, height: 100 }
  expect(toastPosition(window, 356, 54, [raised])).toEqual({ x: 1184, y: 784 })
  expect(toastPosition(window, 356, 180, [raised])).toEqual({ x: 1184, y: 572 })
})

test('resolves composers in multiple panes regardless of measurement order', () => {
  const upper = { x: 900, y: 500, width: 280, height: 140 }
  expect(toastPosition(window, 356, 54, [upper, card])).toEqual({ x: 1184, y: 492 })
  expect(toastPosition(window, 356, 54, [card, upper])).toEqual({ x: 1184, y: 492 })
})
