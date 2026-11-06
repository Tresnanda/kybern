import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { logBoundaryError } from './boundaryLog.ts'
test('caught messages, component stacks and retry decisions are persisted privately', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kybern-boundary-log-'))
  try {
    const file = path.join(dir, 'gpuix-errors.log')
    logBoundaryError('transcript', Error('removed host'), 'at Row', true, file)
    logBoundaryError('transcript', Error('still broken'), 'at Row', false, file)
    const rows = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(rows.map(r => [r.message, r.componentStack, r.autoRetried])).toEqual([['removed host', 'at Row', true], ['still broken', 'at Row', false]])
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
