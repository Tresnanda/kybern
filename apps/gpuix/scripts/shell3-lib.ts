/** Shared launch helper for the shell3 checks (rail, spacing, env motion, nav, resize). */
import path from 'node:path'
import { launch } from '@gpuix/react/automation'

export const OUT = '/Users/mymac/projects/ade/previews/gpuix/shell3'
const KEYS = ['KYBERN_DATA_DIR', 'KYBERN_URL', 'KYBERN_TOKEN', 'KYBERN_GPUIX_THREAD', 'KYBERN_REDUCED_MOTION', 'KYBERN_OPAQUE', 'KYBERN_WINDOW_SIZE', 'KYBERN_CLIENT_CONFIG_DIR', 'KYBERN_GPUIX_CREDENTIALS_DIR']

export async function start(light = false, extra: Record<string, string> = {}) {
  const env = Object.fromEntries(KEYS.flatMap(k => process.env[k] ? [[k, process.env[k]!]] : []))
  const app = await launch({ command: 'bun', args: [path.join(import.meta.dir, '../src/main.tsx')], env: { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: light ? 'light' : 'dark', ...env, ...extra } })
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  return app
}
export async function waitUntil(fn: () => Promise<boolean>, timeoutMs = 20_000, label = 'condition') {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) { try { if (await fn()) return } catch {} await Bun.sleep(60) }
  throw new Error(`timed out waiting for ${label}`)
}
export const exists = (app: Awaited<ReturnType<typeof start>>, id: string) => async () => (await app.getByTestId(id).count()) > 0
