import { expect, test } from 'bun:test'
import type { Block } from '../../../../packages/kybern-client/src/transcript.ts'
import { latestRotation, type RotationBlock } from './rotation.ts'

const filler = (n: number): Block[] => Array.from({ length: n }, (_, i) => ({ kind: 'notice', id: `n${i}`, turnId: 't', at: '', seq: i, level: 'info', text: '' }) as Block)
const rotation = (id: string, pending = false): RotationBlock => ({
  kind: 'rotation', id: `rotation:${id}`, turnId: 't', at: '', seq: 0, rotationId: id, reason: 'budget', pending, usedTokens: 0, windowTokens: null,
  handoff: null, handoffStatus: null, edited: false, carried: null, from: null, to: null,
})

test('the newest rotation is the one that can be edited', () => {
  expect(latestRotation([])).toBeUndefined()
  expect(latestRotation([...filler(3), rotation('a'), ...filler(2), rotation('b'), ...filler(1)])?.rotationId).toBe('b')
})

test('a bounded look-back finds a pending refresh at the tail and stops there', () => {
  const blocks = [rotation('old'), ...filler(200), rotation('now', true), ...filler(3)]
  expect(latestRotation(blocks, 64)?.pending).toBe(true)
  expect(latestRotation([rotation('old'), ...filler(200)], 64)).toBeUndefined()
})
