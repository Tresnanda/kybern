// Launch the real app (src/main.tsx) against the convo9 scratch daemon for the
// lane's verifiers. Never the user's ~/.kybern: SCRATCH must be under gpuix-scratch.
import path from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { launchFixture } from '../requests/harness.ts'
import { CLIENT_DIR, CREDS_DIR, DATA_DIR, SCRATCH, connect, readState } from '../../visual/fixture.ts'

export const ROOT = path.resolve(import.meta.dir, '../..')
export const EVIDENCE = process.env.CONVO9_EVIDENCE ?? '/Users/mymac/projects/ade/previews/gpuix/phase2/convo9'

export type LiveOptions = { theme?: 'dark' | 'light'; reduced?: boolean; thread?: string; env?: Record<string, string>; frameTimes?: boolean; fullRate?: boolean; entry?: string }
export async function launchLive(options: LiveOptions = {}) {
  if (!SCRATCH.includes('gpuix-scratch')) throw Error('Refusing to run outside the scratch dir')
  const state = readState()
  if (!state) throw Error('No scratch daemon: run bun scripts/visual-pair.ts convo9-md-a --keep first')
  rmSync(path.join(DATA_DIR, 'gpuix-ui.json'), { force: true })
  rmSync(CLIENT_DIR, { recursive: true, force: true }); mkdirSync(CLIENT_DIR, { recursive: true })
  const client = await connect(state)
  const { threads } = await client.call('threads.list', {})
  const thread = options.thread ? threads.find(t => t.title === options.thread) : undefined
  const fixture = await launchFixture(path.join(ROOT, options.entry ?? 'src/main.tsx'), {
    GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_APPEARANCE: options.theme ?? 'dark', KYBERN_DATA_DIR: DATA_DIR,
    KYBERN_CLIENT_CONFIG_DIR: CLIENT_DIR, KYBERN_GPUIX_CREDENTIALS_DIR: CREDS_DIR, KYBERN_ENVIRONMENT_NAME: 'Development environment',
    KYBERN_REDUCED_MOTION: options.reduced ? '1' : '0', ...(thread ? { KYBERN_GPUIX_THREAD: thread.id } : {}),
    ...(options.frameTimes ? { KYBERN_FRAME_TIMES: '1' } : {}), ...(options.fullRate ? { KYBERN_FULL_RATE: '1' } : {}), ...options.env,
  })
  await fixture.app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  return { ...fixture, client, threads, thread, async close() { client.close?.(); await fixture.close() } }
}
export const until = async (check: () => Promise<boolean> | boolean, label = 'condition', ms = 8000) => {
  const end = Date.now() + ms
  for (;;) { try { if (await check()) return } catch {} if (Date.now() > end) throw Error(`Timed out: ${label}`); await Bun.sleep(40) }
}
export function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : NaN
}
