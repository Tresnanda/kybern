/** Shared launch helper for the shell3 checks (rail, spacing, env motion, nav, resize). */
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { launch } from '@gpuix/react/automation'

export const OUT = '/Users/mymac/projects/ade/previews/gpuix/round3-resume/shell'
mkdirSync(OUT, { recursive: true })
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

/** The seeded scratch environment held by `scripts/shell3-up.ts`: launches GPUIX against it, optionally opening a fixture thread. */
export async function startScratch(opts: { light?: boolean; thread?: string; env?: Record<string, string> } = {}) {
  const { SCRATCH, DATA_DIR, CLIENT_DIR, CREDS_DIR } = await import('../visual/fixture.ts')
  const { readConversationIds } = await import('../visual/fixture.conversation.ts')
  const up = JSON.parse(await Bun.file(`${SCRATCH}/shell3-up.json`).text()) as { proxy: string; port: number; vite: number }
  const ids = readConversationIds()
  const env: Record<string, string> = { KYBERN_DATA_DIR: DATA_DIR, KYBERN_URL: up.proxy, KYBERN_CLIENT_CONFIG_DIR: CLIENT_DIR, KYBERN_GPUIX_CREDENTIALS_DIR: CREDS_DIR, KYBERN_OPAQUE: '1', KYBERN_ENVIRONMENT_NAME: 'Development environment', ...opts.env }
  if (opts.thread) env.KYBERN_GPUIX_THREAD = ids[opts.thread] ?? opts.thread
  await Bun.$`rm -rf ${CLIENT_DIR} ${DATA_DIR}/gpuix-ui.json`.quiet()
  const app = await launch({ command: 'bun', args: [path.join(import.meta.dir, '../src/main.tsx')], env: { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: opts.light ? 'light' : 'dark', ...env } })
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  return app
}
