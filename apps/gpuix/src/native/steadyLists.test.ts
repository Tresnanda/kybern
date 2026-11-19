import { expect, test } from 'bun:test'
import { holdListInPlace, installSteadyFocus } from './steadyLists.ts'

test('a held list gets its anchor back right after a programmatic focus move', () => {
  const log: string[] = []
  const anchors = new Map<number, number[]>([[3, [2, 228, 844]], [9, [0, 0, 600]]])
  const renderer = {
    focusElement(id: number) { log.push(`focus ${id}`); anchors.set(3, [3, 0, 844]); return id },
    getListScrollTop(id: number) { return anchors.get(id) ?? null },
    scrollToItem(id: number, index: number, offset?: number) { log.push(`scroll ${id} ${index} ${offset}`) },
  }
  installSteadyFocus(renderer)
  installSteadyFocus(renderer)
  expect(renderer.focusElement(7)).toBe(7)
  expect(log).toEqual(['focus 7'])
  anchors.set(3, [2, 228, 844])
  const release = holdListInPlace(3)
  renderer.focusElement(8)
  expect(log).toEqual(['focus 7', 'focus 8', 'scroll 3 2 228'])
  release()
  renderer.focusElement(9)
  expect(log.at(-1)).toBe('focus 9')
})

test('a list without an anchor yet is left alone', () => {
  const log: string[] = []
  const renderer = { focusElement(id: number) { log.push(`focus ${id}`) }, getListScrollTop: () => null, scrollToItem() { log.push('scroll') } }
  installSteadyFocus(renderer)
  const release = holdListInPlace(4)
  renderer.focusElement(1)
  release()
  expect(log).toEqual(['focus 1'])
})
