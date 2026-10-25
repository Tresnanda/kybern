import { mkdirSync, writeFileSync, readFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
export function acquirePreviewUiLock() {
  // macOS keeps the shared /tmp path (clip-lock.ts and the other suites queue on it); elsewhere /tmp may not exist.
  const lock = process.platform === 'darwin' ? '/tmp/kybern-gpuix-round5-ui-lock' : path.join(tmpdir(), 'kybern-gpuix-round5-ui-lock'), owner = path.resolve(import.meta.dir, '../../..')
  // A suite may already hold the lease around checks that acquire it locally.
  // Require an explicit inherited lease and verify its current owner.
  if (process.env.KYBERN_PACING_PARENT_LEASE === owner) {
    if (readFileSync(path.join(lock, 'owner'), 'utf8') !== owner) throw Error('Inherited preview UI lease is no longer owned by this checkout')
    return () => {}
  }
  mkdirSync(lock); writeFileSync(path.join(lock, 'owner'), owner)
  return () => { if (readFileSync(path.join(lock, 'owner'), 'utf8') !== owner) throw Error('Preview UI lock owner changed'); unlinkSync(path.join(lock, 'owner')); rmdirSync(lock) }
}
