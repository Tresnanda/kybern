import { describe, expect, test } from 'bun:test'
import { OfflineError } from '../../../packages/kybern-client/src/machineClient.ts'
import { describeProblem } from '../../../packages/kybern-client/src/problems.ts'
import { requireClient, requireThreadClient } from './state.ts'

// `threadClient(id)!.call` crashed with "Cannot read properties of null" while the app had no connection. The required
// forms throw the offline error an away machine throws, so every caller shows the offline problem instead.
describe('a call that needs a connection the app does not have', () => {
  test('requireClient throws an offline error that names the computer', () => {
    const error = (() => { try { requireClient() } catch (e) { return e } })()
    expect(error).toBeInstanceOf(OfflineError)
    expect(describeProblem(error, { action: 'check Cursor' })).toMatchObject({ kind: 'offline', subject: 'This computer', title: 'This computer is offline' })
  })

  test('requireThreadClient throws the same, never a TypeError', () => {
    expect(() => requireThreadClient('thread-1')).toThrow(OfflineError)
    expect(() => requireThreadClient('thread-1')).not.toThrow(TypeError)
  })
})
