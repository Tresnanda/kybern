/** Scratch daemons for the instant-load bench: data only under `<worktree>/.scratch/gpuix`, ports 4420-4429. */
import { spawn, type ChildProcess } from 'node:child_process'
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { assertScratchEnv } from '../../src/requests/harness.ts'

export const WORKTREE = path.resolve(import.meta.dir, '../../../..')
export const SCRATCH = path.join(WORKTREE, '.scratch', 'gpuix')
export const PRISTINE = path.join(SCRATCH, 'fixture-pristine')
export const PORTS = { min: 4420, max: 4429 }

/** Refuse anything that is not a folder inside `.scratch/gpuix` of this worktree (never `~/.kybern`, never the worktree itself). */
export function assertScratchDir(dir: string): string {
  const resolved = path.resolve(dir)
  const rel = path.relative(SCRATCH, resolved)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw Error(`Refusing ${resolved}: scratch data must be inside ${SCRATCH}`)
  assertScratchEnv({ KYBERN_DATA_DIR: resolved, KYBERN_URL: '' })
  return resolved
}

export function assertPort(port: number): number {
  if (!Number.isInteger(port) || port < PORTS.min || port > PORTS.max) throw Error(`Port ${port} is outside the GPUIX stream's ${PORTS.min}-${PORTS.max}`)
  return port
}

export interface Daemon { dir: string; port: number; url: string; token: string; pid: number; spawnMs: number; stop(): Promise<void> }

/** Start a daemon on a scratch folder and wait until it wrote its port and token files. */
export async function startDaemon(exe: string, dir: string, port: number, timeoutMs = 60_000): Promise<Daemon> {
  dir = assertScratchDir(dir); assertPort(port)
  if (!existsSync(exe)) throw Error(`No daemon binary at ${exe}`)
  for (const file of ['daemon.port', 'daemon.pid']) rmSync(path.join(dir, file), { force: true })
  const started = performance.now()
  const child: ChildProcess = spawn(exe, ['--data-dir', dir, '--port', String(port)], { stdio: 'ignore', windowsHide: true, env: { ...process.env, RUST_LOG: process.env.RUST_LOG ?? 'warn' } })
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path.join(dir, 'daemon.port'))) {
    if (Date.now() > deadline || child.exitCode !== null) { child.kill(); throw Error(`Scratch daemon on ${dir} failed to start (exit ${child.exitCode})`) }
    await Bun.sleep(10)
  }
  const spawnMs = performance.now() - started
  const token = readFileSync(path.join(dir, 'daemon.token'), 'utf8').trim()
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill()
      await new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', () => resolve()) })
    }
  }
  return { dir, port, url: `ws://127.0.0.1:${port}/ws`, token, pid: child.pid!, spawnMs, stop }
}

/** A fresh copy of the pristine fixture for one variant, so a daemon's migrations or caches never leak into another run. */
export function freshCopy(name: string): string {
  if (!existsSync(path.join(PRISTINE, 'fixture.json'))) throw Error('No fixture: run `bun perf/instant-load-2026-11/fixture.ts --daemon <kybernd>` first')
  const dir = assertScratchDir(path.join(SCRATCH, name))
  rmSync(dir, { recursive: true, force: true })
  cpSync(PRISTINE, dir, { recursive: true })
  for (const file of ['daemon.port', 'daemon.pid']) rmSync(path.join(dir, file), { force: true })
  return dir
}

export interface FixtureIds { short: string; medium: string; long: string; others: string[]; projects: number; threads: number; events: number; longTurns: number; mediumTurns: number }
export const readFixture = (): FixtureIds => JSON.parse(readFileSync(path.join(PRISTINE, 'fixture.json'), 'utf8'))
