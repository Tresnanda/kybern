// A thread another machine runs (a delegated child is not in the thread list) is read and changed on that machine,
// whichever window asks: its recorded effort must come from its own daemon, not from a guess made from the id.
import { afterAll, expect, mock, test } from 'bun:test'

const asked: Array<[string, string | undefined]> = []
const calls: string[] = []
const remote = { call: async (method: string) => { calls.push(method); return { target: { provider: { kind: 'claude-code', instance: 'default' }, model: 'opus', effort: 'xhigh' } } } }
const real = await import('../state.ts')
mock.module('../state.ts', () => ({
  ...real,
  threadClient: (id: string, machineId?: string) => { asked.push([id, machineId]); return remote },
}))
const { loadTarget, patch } = await import('./store.ts')

// Other test files share this process: give them the real module back.
afterAll(() => { mock.module('../state.ts', () => real) })

test('loadTarget asks the machine the thread belongs to and records its effort', async () => {
  patch({ target: null })
  await loadTarget('child-1', 'vps')
  expect(asked.at(-1)).toEqual(['child-1', 'vps'])
  expect(calls).toContain('threads.target.get')
})
