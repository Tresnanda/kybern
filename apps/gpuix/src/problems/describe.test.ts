import { describe as suite, expect, test } from 'bun:test'
import { RpcCallError } from '../../../../packages/kybern-client/src/client.ts'
import { OfflineError } from '../../../../packages/kybern-client/src/machineClient.ts'
import { describe, problemLine } from './describe.ts'

const names = (id: string | undefined) => (id === 'sm' ? 'SatyaMas' : undefined)

suite('describe', () => {
  test('an offline machine is named when the error only has its id', () => {
    const view = describe(new OfflineError('sm', false), { action: 'send your message' }, names)
    expect(view).toMatchObject({ kind: 'offline', title: 'SatyaMas is offline' })
  })

  test('an id the app does not know falls back to the generic offline words', () => {
    expect(describe(new OfflineError('gone', false), { action: 'send your message' }, names).title).toBe("Can't reach Kybern to send your message")
  })

  test('the context machine wins over the lookup', () => {
    expect(describe(new OfflineError('sm', false), { action: 'x', machine: 'Instabox' }, names).title).toBe('Instabox is offline')
  })

  test('a missing git is an install, not a failed command', () => {
    const error = new RpcCallError({ code: -32010, message: 'run git: program not found', data: { problem: { kind: 'tool_missing', subject: 'git', detail: 'run git: program not found' } } })
    expect(describe(error, { action: 'read this branch', goal: 'see this branch' }, names)).toMatchObject({ kind: 'tool_missing', subject: 'git', title: 'Install Git to see this branch' })
  })

  test('problemLine is the headline and one sentence, never the raw text', () => {
    const line = problemLine(new Error('RpcCallError: invalid params: missing field `thread_id` (code -32602)'), { action: 'attach the image' })
    expect(line.startsWith("Couldn't attach the image. ")).toBe(true)
    expect(line).not.toMatch(/RpcCallError|invalid params|-32602|thread_id/)
  })
})
