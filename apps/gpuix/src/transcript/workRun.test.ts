import { expect, test } from 'bun:test'
import type { Block } from '../../../../packages/kybern-client/src/transcript.ts'
import { liveAction, runSummary } from './workRun.ts'

let n = 0
const tool = (name: string, input: Record<string, unknown>, extra: Partial<Extract<Block, { kind: 'tool' }>> = {}): Block =>
  ({ kind: 'tool', id: `b${++n}`, turnId: 't', at: '', seq: n, origin: { kind: 'root' }, call: { id: `c${n}`, name, input }, stream: '', output: null, isError: false, complete: true, ...extra }) as Block
const thought = (extra: Record<string, unknown> = {}): Block =>
  ({ kind: 'assistant', id: `b${++n}`, turnId: 't', at: '', seq: n, origin: { kind: 'root' }, messageId: 'm', segment: 0, text: '', thinking: 'hmm', complete: true, ...extra }) as Block

test('a settled run counts by importance, files once each', () => {
  const blocks = [
    tool('Read', { file_path: '/w/a.ts' }),
    tool('Grep', { pattern: 'x' }),
    tool('Read', { file_path: '/w/a.ts' }),
    tool('Edit', { file_path: '/w/a.ts', old_string: 'a', new_string: 'b' }),
    tool('Bash', { command: 'bun test' }),
    thought(),
  ]
  expect(runSummary(blocks)).toEqual({ label: 'Edited 1 file · ran 1 command · read 1 file · searched 1 time', live: null, failed: null })
})

test('while live, settled calls are counted and the call in flight is the tail', () => {
  const blocks = [tool('Read', { file_path: '/w/a.ts' }), tool('Read', { file_path: '/w/src/Requests.tsx' }, { complete: false })]
  expect(runSummary(blocks)).toEqual({ label: 'Read a.ts', live: 'reading Requests.tsx', failed: null })
  expect(runSummary(blocks.slice(1)).live).toBe('Reading Requests.tsx')
  expect(runSummary(blocks.slice(1)).label).toBe('')
})

test('streaming reasoning is the tail; settled reasoning alone reads "Thought"', () => {
  const think = thought({ complete: false })
  expect(runSummary([tool('Bash', { command: 'pnpm typecheck' }), think], think.id)).toEqual({ label: 'Ran pnpm typecheck', live: 'thinking', failed: null })
  expect(runSummary([think], think.id)).toEqual({ label: '', live: 'Thinking', failed: null })
  expect(runSummary([thought()])).toEqual({ label: 'Thought', live: null, failed: null })
  expect(runSummary([tool('Read', { file_path: 'a' })], null, true)).toEqual({ label: 'Read a', live: 'thinking', failed: null })
})

test('failed calls are counted apart', () => {
  expect(runSummary([tool('Read', { file_path: 'a' }), tool('Bash', { command: 'x' }, { isError: true })])).toEqual({ label: 'Read a', live: null, failed: '1 failed' })
  expect(runSummary([tool('Bash', { command: 'x' }, { isError: true }), tool('Bash', { command: 'y' }, { isError: true })])).toEqual({ label: '', live: null, failed: '2 calls failed' })
})

test('background processes are named after the calls', () => {
  const task = { kind: 'runtime_task', id: `b${++n}`, turnId: 't', at: '', seq: n, task: { id: 'p', kind: 'process', status: 'running' } } as unknown as Block
  expect(runSummary([tool('Bash', { command: 'pnpm dev' }), task]).label).toBe('Ran pnpm dev · started 1 background task')
})

test('the live action names the file, command or query', () => {
  expect(liveAction({ id: 'x', name: 'Edit', input: { file_path: '/w/src/Hero.tsx' } })).toBe('Editing Hero.tsx')
  expect(liveAction({ id: 'x', name: 'Bash', input: { command: 'bun test' } })).toBe('Running bun test')
  expect(liveAction({ id: 'x', name: 'Grep', input: { pattern: 'useFresh' } })).toBe('Searching for useFresh')
})

test('one action reads as itself; counts start at two', () => {
  expect(runSummary([tool('Read', { file_path: '/w/styles/system.css' })]).label).toBe('Read system.css')
  expect(runSummary([tool('Read', { file_path: '/w/a.ts' }), tool('Read', { file_path: '/w/a.ts' })]).label).toBe('Read a.ts')
  expect(runSummary([tool('Read', { file_path: '/w/a.ts' }), tool('Read', { file_path: '/w/b.ts' })]).label).toBe('Read 2 files')
  expect(runSummary([tool('Bash', { command: 'bun test' }), tool('Read', { file_path: '/w/a.ts' })]).label).toBe('Ran 1 command · read 1 file')
  expect(runSummary([tool('Grep', { pattern: 'useFresh' })]).label).toBe('Searched for useFresh')
  const long = runSummary([tool('Bash', { command: `bun test ${'src/very/long/path/'.repeat(6)}` })]).label
  expect(long.length).toBeLessThanOrEqual(52)
  expect(long.endsWith('…')).toBe(true)
})
