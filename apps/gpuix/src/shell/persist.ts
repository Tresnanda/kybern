import { activeEnvironment, environmentKey } from './environment.ts'
// A small per-environment JSON store for UI state the desktop keeps in
// `localStorage` (sidebar width, dock width, project order, filters, drafts).
// Keys mirror the desktop's names (`kybern.sidebar.width`, `kybern.dock.width`)
// so the same setting reads the same everywhere.
//
// The file lives beside the daemon's data (`gpuix-ui.json` in `KYBERN_DATA_DIR`
// or `~/.kybern`). An explicit `KYBERN_URL` endpoint has no local data dir, so
// it gets its own file named after a hash of the URL. Reads happen once, at
// first use. `save` only updates memory and arms a debounced write, so it is
// safe from a drag handler or an effect; the write itself is atomic (temp file,
// then rename) and runs off the render path. Every failure is swallowed: these
// are conveniences, and a read-only home must not break the app.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'

const WRITE_DELAY_MS = 400

/** Automated runs (`GPUIX_BACKGROUND=1`) never write into the user's real `~/.kybern`; fixtures use scratch dirs. */
export function writeAllowed(target: string, env: Record<string, string | undefined> = process.env, home = homedir()): boolean {
  if (env.GPUIX_BACKGROUND !== '1') return true
  const real = path.join(home, '.kybern')
  const relative = path.relative(real, path.resolve(target))
  return relative.startsWith('..') || path.isAbsolute(relative)
}
let warned = false

function filePath(): string {
  const env = activeEnvironment()
  const dir = env.dataDir
  if (env.id !== 'local' || (process.env.KYBERN_URL && !process.env.KYBERN_DATA_DIR)) return savedEnvironmentStateFile(dir, environmentKey())
  return path.join(dir, 'gpuix-ui.json')
}

/** The UI-state file of a saved (non-local) environment, so forgetting it can remove the state with it. */
export function savedEnvironmentStateFile(dir: string, key: string): string {
  return path.join(dir, `gpuix-ui-${createHash('sha1').update(key).digest('hex').slice(0, 12)}.json`)
}

let data: Record<string, unknown> | null = null
let file: string | null = null
let timer: ReturnType<typeof setTimeout> | undefined
let dirty = false

function read(): Record<string, unknown> {
  if (data) return data
  file = filePath()
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    data = {}
  }
  return data
}

/** Write pending changes now. The debounce calls this; so does process exit. */
export function flush() {
  clearTimeout(timer)
  timer = undefined
  if (!dirty || !data || !file) return
  dirty = false
  if (!writeAllowed(file)) {
    if (!warned) { warned = true; console.error(`gpuix persist: automation run, not writing ${file}`) }
    return
  }
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(data))
    renameSync(tmp, file)
  } catch {
    // Nothing to do: the next change tries again.
  }
}

let exitHooked = false
function hookExit() {
  if (exitHooked) return
  exitHooked = true
  process.on('exit', flush)
}

/** The saved value for `key`, or `fallback` when it was never saved. */
export function load<T>(key: string, fallback: T): T {
  const value = read()[key]
  return value === undefined ? fallback : (value as T)
}

/** Remember `value` under `key`; `undefined` forgets it. Written shortly after the last change. */
export function save(key: string, value: unknown) {
  const store = read()
  if (value === undefined) {
    if (!(key in store)) return
    delete store[key]
  } else {
    if (JSON.stringify(store[key]) === JSON.stringify(value)) return
    store[key] = value
  }
  dirty = true
  hookExit()
  clearTimeout(timer)
  timer = setTimeout(flush, WRITE_DELAY_MS)
}

/** Whether the store file exists yet (first launch has nothing to restore). */
export const hasSavedState = () => existsSync(filePath())

