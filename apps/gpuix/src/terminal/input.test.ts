import { expect, test } from 'bun:test'
import { inputQueue } from './input.ts'

test('one call in flight; keys typed meanwhile go together, in order', async () => {
  const calls: string[] = [], done: (() => void)[] = []
  const send = inputQueue(data => { calls.push(data.toString()); return new Promise<void>(resolve => done.push(resolve)) }, () => {})
  for (const ch of 'touch') send(Buffer.from(ch))
  expect(calls).toEqual(['t'])
  done.shift()!(); await Bun.sleep(0)
  expect(calls).toEqual(['t', 'ouch'])
  done.shift()!(); await Bun.sleep(0)
  expect(calls).toEqual(['t', 'ouch'])
})

test('a failed call reports and the queue keeps going', async () => {
  const calls: string[] = [], errors: unknown[] = []
  let first = true
  const send = inputQueue(data => { calls.push(data.toString()); if (first) { first = false; return Promise.reject(new Error('busy')) } return Promise.resolve() }, e => errors.push(e))
  send(Buffer.from('a')); send(Buffer.from('b'))
  await Bun.sleep(0); await Bun.sleep(0)
  expect(calls).toEqual(['a', 'b'])
  expect(errors).toHaveLength(1)
})
