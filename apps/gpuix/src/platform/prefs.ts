// App-wide preferences that belong to this installation rather than to one
// environment (the desktop keeps these in its own localStorage): the dismissed
// update announcement, for example. One small JSON file beside the GPUIX
// appearance files; `KYBERN_CLIENT_CONFIG_DIR` moves it for tests.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const file = () => path.join(process.env.KYBERN_CLIENT_CONFIG_DIR ?? path.join(homedir(), 'Library/Application Support/kybern-gpuix'), 'app.json')
let cache: Record<string, unknown> | null = null
function all(): Record<string, unknown> {
  if (cache) return cache
  try { cache = JSON.parse(readFileSync(file(), 'utf8')) as Record<string, unknown> } catch { cache = {} }
  return cache
}
export const readPref = <T>(key: string, fallback: T): T => (key in all() ? all()[key] as T : fallback)
export function writePref(key: string, value: unknown) {
  const next = { ...all(), [key]: value }
  mkdirSync(path.dirname(file()), { recursive: true })
  const temp = `${file()}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(next))
  renameSync(temp, file())
  cache = next
}
