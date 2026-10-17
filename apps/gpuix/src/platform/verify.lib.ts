// Shared helpers for the platform verifiers: the window id of a launched
// app (for `screencapture -l`), and waits on a condition instead of sleeps.
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const WINDOW_ID = path.join(import.meta.dir, '../../native/surface-window-id.swift')

/** The CGWindow number of `pid`'s normal-layer window; retries while it opens. */
export function windowId(pid: number): number {
  for (let i = 0; i < 40; i++) {
    try { return Number(execFileSync('xcrun', ['swift', WINDOW_ID, String(pid)], { encoding: 'utf8' }).trim()) } catch { Bun.sleepSync(250) }
  }
  throw Error(`no window for pid ${pid}`)
}

export async function until<T>(read: () => T | Promise<T>, label: string, timeoutMs = 15_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value) return value as NonNullable<T>
    if (Date.now() > deadline) throw Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

/**
 * Every GPUIX launch from a check runs against a scratch daemon: a run that
 * resolves the real data dir can restart the user's daemon. Throws before any
 * launch unless `dir` is set and is not `~/.kybern` (symlinks resolved).
 */
export function assertScratchDataDir(dir = process.env.KYBERN_DATA_DIR): string {
  if (!dir) throw Error('Set KYBERN_DATA_DIR to a scratch data dir before launching GPUIX; the real ~/.kybern is never used by checks.')
  const real = (p: string) => { try { return realpathSync(p) } catch { return path.resolve(p) } }
  if (real(dir) === real(path.join(homedir(), '.kybern'))) throw Error(`Refusing to launch against the real data dir ${dir}; use a scratch KYBERN_DATA_DIR.`)
  return dir
}
