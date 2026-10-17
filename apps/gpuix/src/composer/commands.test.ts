import { describe, expect, test } from 'bun:test'
import { LOCAL_COMMAND_NAMES, threadCommandSpecs } from '@/lib/threadCommands'

const names = (specs: ReturnType<typeof threadCommandSpecs>) => specs.map(spec => spec.name)
const native = [{ name: 'review', description: 'Review a diff' }, { name: 'stop', description: 'Harness stop' }, { name: 'compact', description: 'Compact' }]

describe('thread slash commands (shared with the desktop)', () => {
  test('a project thread lists the desktop order', () => {
    expect(names(threadCommandSpecs({ freeChat: false, canCompact: true, providerKind: 'codex', nativeCommands: [] }))).toEqual(
      ['resume', 'sessions', 'compact', 'new', 'reconnect', 'stop', 'activity', 'agents', 'attach', 'terminal', 'changes', 'files', 'environment', 'pr', 'archive', 'settings', 'usage'])
  })
  test('a free chat has no project panels and its own new-thread hint', () => {
    const specs = threadCommandSpecs({ freeChat: true, canCompact: false, providerKind: 'codex', nativeCommands: [] })
    expect(names(specs)).toEqual(['resume', 'sessions', 'new', 'reconnect', 'stop', 'activity', 'agents', 'attach', 'terminal', 'archive', 'settings', 'usage'])
    expect(specs.find(spec => spec.name === 'new')?.hint).toBe('Start a new free chat')
  })
  test('harness commands come after compact, collide through a harness: prefix, and never repeat compact', () => {
    const specs = threadCommandSpecs({ freeChat: false, canCompact: true, providerKind: 'claude-code', nativeCommands: native })
    expect(names(specs).slice(0, 6)).toEqual(['resume', 'sessions', 'compact', 'review', 'harness:stop', 'new'])
    expect(specs.find(spec => spec.name === 'harness:stop')).toMatchObject({ kind: 'native', invocation: 'stop' })
    expect(specs.find(spec => spec.name === 'review')?.hint).toBe('Claude Code · Review a diff')
  })
  test('every local command is reserved against harness names', () => {
    const specs = threadCommandSpecs({ freeChat: false, canCompact: true, providerKind: 'codex', nativeCommands: [] })
    for (const spec of specs) if (spec.kind === 'local' && spec.name !== 'compact' && spec.name !== 'reconnect' && spec.name !== 'agents') expect(LOCAL_COMMAND_NAMES as readonly string[]).toContain(spec.name)
  })
})
