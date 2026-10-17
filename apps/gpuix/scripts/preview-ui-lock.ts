import { mkdirSync, writeFileSync, readFileSync, unlinkSync, rmdirSync } from 'node:fs'
import path from 'node:path'
export function acquirePreviewUiLock() {
  const lock = '/tmp/kybern-gpuix-round5-ui-lock', owner = path.resolve(import.meta.dir, '../../..')
  if (process.env.KYBERN_PACING_PARENT_LEASE === owner && readFileSync(path.join(lock, 'owner'), 'utf8') === owner) return () => {}
  mkdirSync(lock); writeFileSync(path.join(lock, 'owner'), owner)
  return () => { if (readFileSync(path.join(lock, 'owner'), 'utf8') !== owner) throw Error('Preview UI lock owner changed'); unlinkSync(path.join(lock, 'owner')); rmdirSync(lock) }
}
