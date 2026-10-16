import { expect, test } from 'bun:test'
import { bindNativeCarry, createCarryStore } from './carry.ts'

test('carry sends exact native translations and stops when its host detaches', () => {
  const store = createCarryStore(), batches: unknown[][] = []
  store.set(200, 100)
  const stop = bindNativeCarry({ applyBatch(json) { batches.push(JSON.parse(json)); return [] } }, 7, { x: 180, y: 80 }, store)
  store.set(220, 130)
  store.set(220, 130)
  expect(batches).toHaveLength(2)
  const mutation = batches[1]![0] as [string, number, string, { animate: object; transition: object }]
  expect(mutation.slice(0, 3)).toEqual(['setCustomProp', 7, 'motion'])
  expect(mutation[3].animate).toEqual({ translateX: 40, translateY: 50 })
  expect(mutation[3].transition).toEqual({ duration: 0 })
  stop()
  store.set(300, 200)
  expect(batches).toHaveLength(2)
})
