// Native fixture for Settings › Storage (#298): the page in the state `STORAGE_FIXTURE` names, from fixed numbers. No daemon is
// touched. Drive it with `storage.shots.ts`.
import '../native/local-build.ts'
import { render } from '@gpuix/react'
import { ThemeProvider, useTheme } from '../ui.tsx'
import { StorageView } from './Storage.tsx'
import type { StorageStats } from '../../../../packages/kybern-client/src/types.ts'

const GB = 1_000_000_000
const base: StorageStats = {
  database_bytes: 7.5 * GB, files_bytes: 4.1 * GB, reclaimable_bytes: 4.9 * GB, compacted_bytes: 2.6 * GB, needed_disk_bytes: 5.2 * GB,
  free_disk_bytes: 180 * GB, media_rewrite: { processed: 13_100, total: 13_100, done: true }, reclaim: { state: 'idle' },
}
const STATES: Record<string, Partial<StorageStats>> = {
  idle: {},
  moving: { files_bytes: 1.2 * GB, media_rewrite: { processed: 8_400, total: 13_100, done: false } },
  reclaiming: { reclaim: { state: 'running', written_bytes: 1.1 * GB, total_bytes: 2.6 * GB } },
  done: { database_bytes: 2.6 * GB, reclaimable_bytes: 0, reclaim: { state: 'done', freed_bytes: 4.9 * GB } },
  'low-disk': { free_disk_bytes: 1.8 * GB },
  nothing: { database_bytes: 2.6 * GB, reclaimable_bytes: 4 * 1024 * 1024 },
  failed: { reclaim: { state: 'failed', message: 'disk I/O error' } },
}
const state = process.env.STORAGE_FIXTURE ?? 'idle'

function Fixture() {
  const t = useTheme()
  return <div testId="fixture-ready" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', paddingTop: 32, backgroundColor: t.surface }}>
    <StorageView stats={{ ...base, ...STATES[state] }} onReclaim={() => {}} />
  </div>
}
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Storage', width: 860, height: 420, focus: false })
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
