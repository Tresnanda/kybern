// Shared helpers for the platform verifiers: the window id of a launched
// app (for `screencapture -l`), and waits on a condition instead of sleeps.
import { execFileSync } from 'node:child_process'
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
