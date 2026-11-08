import { describe, expect, test } from 'bun:test'
import { RpcCallError } from '../../../../packages/kybern-client/src/client.ts'
import { codes } from '../../../../packages/kybern-client/src/types.ts'
import { loadFailureCopy } from './loadFailure.ts'

const busy = new RpcCallError({
  code: codes.CAPACITY_EXCEEDED,
  message: 'Too many calls in flight on this connection; try again in a moment',
  data: { problem: { kind: 'conflict', subject: 'busy', retryable: true } },
})

describe('loadFailureCopy', () => {
  test('a busy daemon says so in plain words', () => {
    expect(loadFailureCopy(busy)).toEqual({ title: 'Couldn’t load tasks', description: 'Kybern was busy with other requests. Try again in a moment.' })
  })
  test('the old daemon’s raw refusal reads the same', () => {
    const old = new RpcCallError({ code: codes.INTERNAL_ERROR, message: 'Too many concurrent requests; retry after pending requests finish' })
    expect(loadFailureCopy(old).description).toBe('Kybern was busy with other requests. Try again in a moment.')
  })
  test('an unreachable machine is named', () => {
    const offline = Object.assign(new Error('SatyaMas is offline. Try again when it reconnects.'), { name: 'OfflineError' })
    expect(loadFailureCopy(offline).description).toBe('Kybern can’t reach SatyaMas. Check that it’s on and connected, then try again.')
  })
  test('anything else is a sentence, never the raw text', () => {
    const copy = loadFailureCopy(new RpcCallError({ code: codes.INTERNAL_ERROR, message: 'sqlite: database is locked (code 5)' }))
    expect(copy.description).toBe('Something went wrong. Try again in a moment.')
    expect(copy.title).not.toMatch(/sqlite|RPC/i)
  })
})
