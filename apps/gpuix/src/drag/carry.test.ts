import { expect, test } from 'bun:test'
import { bindNativeCarry, createCarryStore } from './carry.ts'
import { createMutationQueue } from '@gpuix/native/host'

test('carry sends exact native translations and stops when its host detaches', () => {
  const store = createCarryStore(), moves: unknown[] = []
  store.set(200, 100)
  const stop = bindNativeCarry({ applyBatch() { throw Error('carry must not invalidate the retained tree') }, setSubtreeTranslation(id, translation) { moves.push([id, translation]) } }, 7, { x: 180, y: 80 }, store)
  store.set(220, 130)
  store.set(220, 130)
  expect(moves).toEqual([[7, { translateX: 20, translateY: 20 }], [7, { translateX: 40, translateY: 50 }]])
  stop()
  store.set(300, 200)
  expect(moves).toHaveLength(2)
})

test('unchanged React translations preserve native carry offsets and clear declaration identity on remount', () => {
  const batches: unknown[][] = []
  const mutations = createMutationQueue({ applyBatch(json) { const batch = JSON.parse(json); batches.push(batch); return batch.some((op: unknown[]) => op[0] === 'destroyElement') ? [7] : [] } })
  const declaration = () => ({ initial: false, animate: { translateX: 0, translateY: 0 }, transition: { duration: 0 } })
  mutations.createElement(7, 'div')
  mutations.setCustomProp(7, 'paintTranslate', declaration())
  mutations.flushMutations()
  mutations.setCustomProp(7, 'paintTranslate', declaration())
  expect(mutations.pending).toBe(0)
  mutations.setCustomProp(7, 'paintTranslate', { ...declaration(), generation: 2 })
  expect(mutations.pending).toBe(1)
  mutations.flushMutations()
  mutations.destroyElement(7)
  mutations.flushMutations()
  mutations.createElement(7, 'div')
  mutations.setCustomProp(7, 'paintTranslate', declaration())
  expect(mutations.pending).toBe(2)
  expect(batches).toHaveLength(3)
})
