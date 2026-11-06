// Caught React errors survive an app restart, beside the native frame log.
import { errorMessage } from '../../../../packages/kybern-client/src/problem.ts'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'
import { localDataDir } from '../environments/registry.ts'
import { writeAllowed } from '../shell/persist.ts'

export function logBoundaryError(surface: string, error: Error, componentStack: string, autoRetried: boolean, file = path.join(localDataDir, 'gpuix-errors.log')) {
  if (!writeAllowed(file)) return
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 256 * 1024) renameSync(file, `${file}.old`)
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), surface, message: errorMessage(error), stack: error.stack, componentStack, autoRetried }) + '\n', { mode: 0o600 })
  } catch { /* A read-only data dir keeps the console diagnostic. */ }
}
