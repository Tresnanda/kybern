/**
 * Real Tauri dev window capture for the pair tool (`--tauri-window`).
 *
 * Runs `pnpm tauri dev` from this checkout's apps/desktop against the scratch
 * daemon's data dir (never ~/.kybern, never the installed app) and captures only
 * the dev process's window with `screencapture -l`. The installed app has the same
 * process name, so the window is found by the dev binary's path/pid, not by name.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { DATA_DIR, SCRATCH } from './fixture.ts'

const root = path.resolve(import.meta.dir, '../../..')
const devBin = path.join(root, 'target/debug/kybern-desktop')
const log = path.join(SCRATCH, 'tauri-dev.log')

function pids(): number[] {
  const r = Bun.spawnSync(['pgrep', '-f', devBin])
  return r.stdout.toString().split('\n').map(Number).filter(Boolean)
}
export const devWindowPid = () => pids().find((p) => Bun.spawnSync(['ps', '-o', 'comm=', '-p', String(p)]).stdout.toString().trim() === devBin)

export async function tauriWindowUp(timeoutMs = 20 * 60_000): Promise<number> {
  if (!DATA_DIR.includes('gpuix-scratch') || !existsSync(path.join(DATA_DIR, 'daemon.port'))) throw new Error('scratch daemon data dir missing; run without --tauri-window first')
  let pid = devWindowPid()
  if (!pid) {
    mkdirSync(SCRATCH, { recursive: true })
    const out = Bun.file(log).writer()
    writeFileSync(log, '')
    const child = spawn('pnpm', ['tauri', 'dev'], {
      cwd: path.join(root, 'apps/desktop'),
      env: { ...process.env, CARGO_TARGET_DIR: path.join(root, 'target'), CARGO_INCREMENTAL: '0', KYBERN_DATA_DIR: DATA_DIR, KYBERN_NO_ACTIVATE: '1' },
      stdio: ['ignore', 'ignore', 'ignore'], detached: true,
    })
    child.unref()
    void out
    const t = Date.now()
    while (!(pid = devWindowPid())) {
      if (Date.now() - t > timeoutMs) throw new Error('tauri dev did not start')
      await Bun.sleep(2000)
    }
    await Bun.sleep(6000)
  }
  return pid
}

/** Capture the dev window (no shadow) to `file`. */
export function tauriWindowShot(pid: number, file: string) {
  const id = Bun.spawnSync(['swift', path.join(import.meta.dir, 'window-id.swift'), String(pid)]).stdout.toString().trim()
  if (!id) throw new Error('no dev window found')
  const r = Bun.spawnSync(['screencapture', '-x', '-o', '-l', id, file])
  if (r.exitCode !== 0) throw new Error(`screencapture: ${r.stderr}`)
}

export function tauriWindowDown() {
  for (const p of pids()) try { process.kill(p) } catch {}
  Bun.spawnSync(['pkill', '-f', `${root}/apps/desktop/node_modules/.*tauri`])
  Bun.spawnSync(['pkill', '-f', `${root}/target/debug`])
}
