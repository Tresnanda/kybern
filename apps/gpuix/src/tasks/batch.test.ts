import { expect, test } from 'bun:test'
import { dockRoom } from './dockRoom.ts'
import { footVisible, removeFromRun } from './batch.ts'

test('removing a task from the run drops it from the selection and keeps the rest', () => {
  const next = removeFromRun(['a', 'b', 'c'], new Set(['a', 'b', 'c', 'd']), 'b')
  expect(next.composer).toEqual(['a', 'c'])
  expect([...next.selected]).toEqual(['a', 'c', 'd'])
})

test('removing the last task closes the composer', () => {
  const next = removeFromRun(['a'], new Set(['a']), 'a')
  expect(next.composer).toBeNull()
  expect(next.selected.size).toBe(0)
})

test('removing a task that is not in the run changes nothing', () => {
  expect(removeFromRun(['a', 'b'], new Set(['a']), 'z').composer).toEqual(['a', 'b'])
})

test('the selection bar and the hints hide while the composer is open and return after it', () => {
  expect(footVisible({ selected: 4, composer: false, showHints: true })).toEqual({ bar: true, hints: true })
  expect(footVisible({ selected: 4, composer: true, showHints: true })).toEqual({ bar: false, hints: false })
  expect(footVisible({ selected: 0, composer: false, showHints: true })).toEqual({ bar: false, hints: true })
  expect(footVisible({ selected: 4, composer: false, showHints: false })).toEqual({ bar: true, hints: false })
})

test('the list leaves room for the dock: its own height on glass, a spacer under the band elsewhere', () => {
  expect(dockRoom(true, 150)).toEqual({ inset: 150, spacer: 0 })
  expect(dockRoom(false, 150)).toEqual({ inset: 0, spacer: 162 })
})
