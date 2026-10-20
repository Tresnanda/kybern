import { expect, test } from 'bun:test'
import { writeAllowed } from './persist.ts'

const home = '/Users/someone'

test('automation runs never write into the real ~/.kybern', () => {
  const env = { GPUIX_BACKGROUND: '1' }
  expect(writeAllowed('/Users/someone/.kybern/gpuix-ui.json', env, home)).toBe(false)
  expect(writeAllowed('/Users/someone/.kybern/gpuix-ui-abc123.json', env, home)).toBe(false)
  expect(writeAllowed('/tmp/gpuix-scratch/data/gpuix-ui.json', env, home)).toBe(true)
  expect(writeAllowed('/Users/someone/.kybern-scratch/gpuix-ui.json', env, home)).toBe(true)
})

test('normal runs write wherever the environment points', () => {
  expect(writeAllowed('/Users/someone/.kybern/gpuix-ui.json', {}, home)).toBe(true)
})
