/** Shared launch + OS-pointer helpers for the kit9 (Phase 2 primitives) checks. */
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { launchFixture } from '../native/frame-harness.ts'
import { CLIENT_DIR as SEED_CLIENT, DATA_DIR as SEED_DATA, readState } from '../visual/fixture.ts'

/** The notes/tasks seeded scratch daemon held by `bun scripts/visual-pair.ts … --keep` (this checkout's slot). */
export const SEEDED = { dataDir: SEED_DATA, clientDir: SEED_CLIENT, state: readState }

export const SCRATCH = '/Users/mymac/projects/ade-gpuix-scratch'
export const DATA_DIR = `${SCRATCH}/phase2-kit9`
export const CLIENT_DIR = `${SCRATCH}/phase2-kit9-client`
export const EVIDENCE = '/Users/mymac/projects/ade/previews/gpuix/phase2/kit9'
mkdirSync(EVIDENCE, { recursive: true })

export interface StartOptions { light?: boolean; reduced?: boolean; full?: boolean; env?: Record<string, string>; size?: string; seeded?: boolean; /** Keep the window on screen at floating level (timing and resource runs). */ visible?: boolean }

export async function start(opts: StartOptions = {}) {
  const env: Record<string, string> = {
    GPUIX_BACKGROUND: '1',
    KYBERN_APPEARANCE: opts.light ? 'light' : 'dark',
    KYBERN_DATA_DIR: opts.seeded ? SEED_DATA : DATA_DIR,
    KYBERN_CLIENT_CONFIG_DIR: opts.seeded ? SEED_CLIENT : CLIENT_DIR,
    KYBERN_OPAQUE: '1',
    KYBERN_WINDOW_SIZE: opts.size ?? '1280x820',
    ...(opts.reduced ? { KYBERN_REDUCED_MOTION: '1' } : {}),
    ...(opts.full ? { KYBERN_FULL_RATE: '1' } : {}),
    ...opts.env,
  }
  // KYBERN_FRAME_TIMES makes the patched native layer log every presented frame (`[kybern-frame] <ms>`).
  const f = await launchFixture(path.join(import.meta.dir, opts.visible ? 'kit9-app.ts' : '../src/main.tsx'), { KYBERN_FRAME_TIMES: '1', ...env })
  const app = f.app
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  return Object.assign(app, { pid: f.pid, frameTimes: f.frameTimes, counts: f.counts, diagnostics: f.diagnostics, closeAll: f.close })
}
export type App = Awaited<ReturnType<typeof start>>

export async function waitUntil(fn: () => Promise<boolean> | boolean, timeoutMs = 20_000, label = 'condition') {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) { try { if (await fn()) return } catch {} await Bun.sleep(40) }
  throw new Error(`timed out waiting for ${label}`)
}

/** Frame of the largest layer-0 window of `pid` in screen points (top-left origin), or null. */
export function windowFrame(pid: number): { x: number; y: number; w: number; h: number; id: number } | null {
  const r = Bun.spawnSync(['swift', path.join(import.meta.dir, 'kit9-window.swift'), String(pid)], { stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) return null
  const [id, x, y, w, h] = r.stdout.toString().trim().split(/\s+/).map(Number)
  return { id: id!, x: x!, y: y!, w: w!, h: h! }
}

const QUEUE = '/tmp/kybern-gpuix-ui-queue'
/** Join the shared UI queue, wait until first, hold the native UI lock for `fn` (≤5 min), then leave the queue and re-append nothing. */
export async function withUiLock<T>(fn: () => Promise<T>): Promise<T> {
  const { acquirePreviewUiLock } = await import('./preview-ui-lock.ts')
  const fs = await import('node:fs')
  const name = 'kit9'
  const lines = () => (fs.existsSync(QUEUE) ? fs.readFileSync(QUEUE, 'utf8').split('\n').filter(Boolean) : [])
  if (!lines().includes(name)) fs.appendFileSync(QUEUE, name + '\n')
  await waitUntil(() => lines()[0] === name, 15 * 60_000, 'UI queue turn')
  let release: (() => void) | undefined
  await waitUntil(() => { try { release = acquirePreviewUiLock(); return true } catch { return false } }, 5 * 60_000, 'UI lock')
  try { return await fn() } finally {
    try { release?.() } catch {}
    fs.writeFileSync(QUEUE, lines().filter((l) => l !== name).join('\n') + (lines().filter((l) => l !== name).length ? '\n' : ''))
  }
}

/** Real OS pointer via cliclick. Coordinates are screen points. */
export function pointer(...cmds: string[]) {
  const r = Bun.spawnSync(['cliclick', '-e', '0', ...cmds], { stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`cliclick ${cmds.join(' ')}: ${r.stderr.toString()}`)
}
/** Verify `(x,y)` hits one of pid's windows, not someone else's. */
export function topWindowPidAt(x: number, y: number): number | null {
  const r = Bun.spawnSync(['swift', path.join(import.meta.dir, 'kit9-hit.swift'), String(x), String(y)], { stdout: 'pipe', stderr: 'pipe' })
  return r.exitCode === 0 ? Number(r.stdout.toString().trim()) : null
}

/** pid of the app `launch` started from this checkout. */
export function appPid(): number {
  const r = Bun.spawnSync(['pgrep', '-f', `${path.resolve(import.meta.dir, '..')}/src/main.tsx`], { stdout: 'pipe' })
  const pids = r.stdout.toString().trim().split('\n').filter(Boolean).map(Number)
  return pids[pids.length - 1]!
}
