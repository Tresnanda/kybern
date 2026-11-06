import { expect, test } from 'bun:test'
import { allowOutsideFile, askOutside, currentOutsideRequest, outsideChoices } from './outsideFile.ts'
import type { ThreadFileOutsideParams, ThreadFileOutsideResult } from '../../../../packages/kybern-client/src/types.ts'

const THREAD = 'thread-1'
const client = (answers: ThreadFileOutsideResult[]) => {
  const calls: ThreadFileOutsideParams[] = []
  return { calls, call: async (_m: 'threads.files.outside', params: ThreadFileOutsideParams) => { calls.push(params); const next = answers.shift(); if (!next) throw new Error('no answer'); return next } }
}

test('the scratchpad folder is the default choice, a plain folder defaults to opening once, and an ungrantable folder only opens once', () => {
  expect(outsideChoices({ scratch: true, folder: true })).toEqual(['folder', 'once'])
  expect(outsideChoices({ scratch: false, folder: true })).toEqual(['once', 'folder'])
  expect(outsideChoices({ scratch: true, folder: false })).toEqual(['once'])
})

test('an allowed file opens without asking', async () => {
  const c = client([{ verdict: 'open', path: '/tmp/x/plan.md' }])
  expect(await allowOutsideFile(c, THREAD, '/tmp/x/plan.md')).toBe('/tmp/x/plan.md')
  expect(c.calls).toEqual([{ thread_id: THREAD, path: '/tmp/x/plan.md' }])
})

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('an unallowed file asks, then opens with the answer the user gave', async () => {
  const c = client([{ verdict: 'ask', path: '/tmp/x/plan.md', folder: '/tmp/x', scratch: true }, { verdict: 'open', path: '/tmp/x/plan.md' }])
  const opened = allowOutsideFile(c, THREAD, '/tmp/x/plan.md')
  await tick()
  expect(currentOutsideRequest()).toMatchObject({ path: '/tmp/x/plan.md', scratch: true, folder: true })
  currentOutsideRequest()!.answer('folder')
  expect(await opened).toBe('/tmp/x/plan.md')
  expect(c.calls).toEqual([{ thread_id: THREAD, path: '/tmp/x/plan.md' }, { thread_id: THREAD, path: '/tmp/x/plan.md', allow: 'folder' }])
  expect(currentOutsideRequest()).toBeNull()
})

test('dismissing the question allows nothing', async () => {
  const c = client([{ verdict: 'ask', path: '/tmp/x/plan.md', folder: '/tmp/x' }])
  const opened = allowOutsideFile(c, THREAD, '/tmp/x/plan.md')
  await tick()
  currentOutsideRequest()!.answer(null)
  expect(await opened).toBe('cancelled')
  expect(c.calls).toHaveLength(1)
})

test('a new question dismisses the one before it', async () => {
  const first = askOutside({ path: '/a', scratch: false, folder: true })
  const second = askOutside({ path: '/b', scratch: false, folder: true })
  expect(await first).toBeNull()
  currentOutsideRequest()!.answer('once')
  expect(await second).toBe('once')
})

test('a refused file says why, and a failing check leaves the link as written', async () => {
  const refused = client([{ verdict: 'refused', reason: 'Open it in Kybern on the computer it is on.' }])
  await expect(allowOutsideFile(refused, THREAD, '/tmp/y')).rejects.toThrow('Open it in Kybern on the computer it is on.')
  expect(await allowOutsideFile(client([]), THREAD, '/tmp/y')).toBeNull()
  expect(await allowOutsideFile(null, THREAD, '/tmp/y')).toBeNull()
})
