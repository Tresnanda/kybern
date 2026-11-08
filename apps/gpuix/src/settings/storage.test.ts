import { expect, test } from 'bun:test'
import { formatBytes, reclaimView } from './Storage.tsx'
import type { StorageStats } from '../../../../packages/kybern-client/src/types.ts'

const GB = 1_000_000_000
const stats = (patch: Partial<StorageStats> = {}): StorageStats => ({
  database_bytes: 7.5 * GB, files_bytes: 4.1 * GB, reclaimable_bytes: 4.9 * GB, compacted_bytes: 2.6 * GB, needed_disk_bytes: 5.2 * GB,
  free_disk_bytes: 200 * GB, media_rewrite: { processed: 13_100, total: 13_100, done: true }, reclaim: { state: 'idle' }, ...patch,
})

test('sizes read like Finder: decimal units, one decimal below 100', () => {
  expect(formatBytes(4.9 * GB)).toBe('4.9 GB')
  expect(formatBytes(145_000_000)).toBe('145 MB')
  expect(formatBytes(512)).toBe('512 bytes')
})

test('the reclaim row offers only an action that can run', () => {
  expect(reclaimView(null).kind).toBe('loading')
  expect(reclaimView(stats())).toEqual({ kind: 'idle', free: 4.9 * GB })
  expect(reclaimView(stats({ media_rewrite: { processed: 8_400, total: 13_100, done: false } })).kind).toBe('moving')
  expect(reclaimView(stats({ free_disk_bytes: 1.8 * GB }))).toEqual({ kind: 'low-disk', need: 5.2 * GB, free: 1.8 * GB })
  expect(reclaimView(stats({ reclaimable_bytes: 1024 })).kind).toBe('nothing')
  expect(reclaimView(stats({ reclaim: { state: 'running', written_bytes: 1.1 * GB, total_bytes: 2.6 * GB } }))).toEqual({ kind: 'reclaiming', written: 1.1 * GB, total: 2.6 * GB })
  expect(reclaimView(stats({ reclaim: { state: 'running', total_bytes: 2.6 * GB, finishing: true } }))).toEqual({ kind: 'reclaiming', written: null, total: 2.6 * GB })
  expect(reclaimView(stats({ reclaim: { state: 'done', freed_bytes: 4.9 * GB } }))).toEqual({ kind: 'done', freed: 4.9 * GB })
  expect(reclaimView(stats({ reclaim: { state: 'failed', message: 'x' } })).kind).toBe('failed')
  // Running wins over everything that would keep a new run from starting.
  expect(reclaimView(stats({ free_disk_bytes: 0, reclaim: { state: 'running', written_bytes: 0, total_bytes: 1 } })).kind).toBe('reclaiming')
})
