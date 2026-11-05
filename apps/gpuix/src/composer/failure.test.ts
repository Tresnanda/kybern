import { describe, expect, test } from 'bun:test'
import { RpcCallError } from '../../../../packages/kybern-client/src/client.ts'
import { OfflineError } from '../../../../packages/kybern-client/src/machineClient.ts'
import { asSendFailure, sendFailure } from './failure.ts'

describe('a message that did not go', () => {
  test('says what happened and that the text is saved', () => {
    const line = sendFailure(new RpcCallError({ code: -32012, message: 'thread is no longer idle', data: { problem: { kind: 'conflict', detail: 'thread is no longer idle' } } }))
    expect(line).toBe("Couldn't send your message. Thread is no longer idle. Your message is saved.")
  })

  test('a machine that is away is named, not "Cannot read properties of null"', () => {
    const line = sendFailure(new OfflineError('sm', false, 'SatyaMas is offline. Try again when it reconnects.'))
    expect(line).toContain('SatyaMas is offline')
    expect(line).not.toMatch(/properties of null|OfflineError/)
    expect(line.endsWith('Your message is saved.')).toBe(true)
  })

  test('a missing agent is an install, in words', () => {
    const line = sendFailure(new RpcCallError({ code: -32010, message: 'run claude: program not found', data: { problem: { kind: 'tool_missing', subject: 'claude', detail: 'run claude: program not found' } } }))
    expect(line).toContain('Install Claude Code')
    expect(line).not.toContain('program not found')
  })

  test('text an outbox item recorded is described once, and a finished line is left alone', () => {
    const line = asSendFailure('Connection closed')
    expect(line.endsWith('Your message is saved.')).toBe(true)
    expect(asSendFailure(line)).toBe(line)
  })
})
