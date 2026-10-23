import { describe, expect, test } from 'bun:test'
import type { Block } from '../../../../packages/kybern-client/src/transcript.ts'
import { commandOf, printedText, signInRows } from './signIn.ts'

const tool = (id: string, input: unknown, output: unknown, complete = true, stream = ''): Block => ({
  kind: 'tool', id: `tool:${id}`, turnId: 'turn', at: '2026-10-23T00:00:00Z', seq: 1, origin: { kind: 'root' }, call: { id, name: 'Bash', input }, stream, output, isError: true, complete,
} as Block)

describe('sign-in chips on tool rows', () => {
  test('reads the command as a string, argv or cmd', () => {
    expect(commandOf({ command: 'gh pr create' })).toBe('gh pr create')
    expect(commandOf({ command: ['vercel', 'deploy'] })).toBe('vercel deploy')
    expect(commandOf({ cmd: 'eas build' })).toBe('eas build')
    expect(commandOf('gh')).toBe('')
  })

  test('looks at stderr and the live stream too', () => {
    expect(printedText({ stdout: '', stderr: 'gh auth login' }, '')).toContain('gh auth login')
    expect(printedText(null, 'No access token available')).toBe('No access token available')
  })

  test('one chip per CLI: the latest finished failure in the turn', () => {
    const chips = signInRows([
      tool('a', { command: 'gh pr create --fill' }, 'To get started with GitHub CLI, please run:  gh auth login'),
      tool('b', { command: 'vercel deploy --prebuilt' }, { stderr: 'Error: No existing credentials found.' }),
      tool('c', { command: 'gh pr view' }, 'You are not logged in to any GitHub hosts.'),
      tool('d', { command: 'gh pr list' }, null, false, 'gh auth login'),
      tool('e', { path: 'README.md' }, 'gh auth login'),
    ])
    expect([...chips.keys()].sort()).toEqual(['b', 'c'])
    expect(chips.get('b')?.service).toBe('Vercel')
  })
})
