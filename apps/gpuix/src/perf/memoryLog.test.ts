import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'kybern-memory-log-'))
process.env.KYBERN_CLIENT_CONFIG_DIR = dir
process.env.KYBERN_MEMORY_LOG_MS = '3600000'
const { addMemoryContext, memoryStep, sampleMemory, startMemoryLog } = await import('./memoryLog.ts')

test('a line carries the footprint, the JS heap, each context and the steps since the last line', () => {
  startMemoryLog()
  addMemoryContext('panes', () => [{ thread: 't1', blocks: 3 }])
  memoryStep('thread-open', { id: 't1' })
  sampleMemory('test')
  const lines = readFileSync(path.join(dir, 'memory.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(lines[0].reason).toBe('launch')
  const line = lines.at(-1)
  // The physical footprint comes from macOS (`rusage_info_v0`); elsewhere the line carries null.
  if (process.platform === 'darwin') expect(line.footprintMb).toBeGreaterThan(1)
  else expect(line.footprintMb).toBeNull()
  expect(line.js.heapMb).toBeGreaterThan(0)
  expect(line.panes).toEqual([{ thread: 't1', blocks: 3 }])
  expect(line.steps.map((s: { phase: string }) => s.phase)).toEqual(['thread-open'])
  // Steps go out once.
  sampleMemory('test')
  expect(JSON.parse(readFileSync(path.join(dir, 'memory.jsonl'), 'utf8').trim().split('\n').at(-1)!).steps).toBeUndefined()
})
