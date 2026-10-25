// One window per environment (desktop `environment_open_window`, issue #108 §27.8).
//
// GPUIX opens one native window per process: the renderer keeps its window,
// scroll/list handles and key routing in thread-locals, and every app store
// (`state.ts`, `shell/environment.ts`, transcripts, navigation) is module
// state, which is what one Tauri webview's JS realm is. So a window is a
// process, and this registry makes the processes act as one app:
//
// - every window claims `<client config>/gpuix-windows/<pid>.json` with the
//   environment it shows and a Unix socket, rewritten when it switches;
// - "Open in a new window" focuses the window that already shows that
//   environment (asking it over its socket), and only spawns a process when
//   none does. The spawned pid is claimed before the child is up, so a second
//   click waits for that window instead of opening another;
// - claims of processes that are gone are dropped when read;
// - the updater asks every other window to quit before it runs the installer
//   (`quitOtherWindows`), because each process keeps the install's files locked.
//
// The directory follows `KYBERN_CLIENT_CONFIG_DIR`, so checks never see the
// user's windows. No timers: the socket only wakes on a request.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { configDir } from '../environments/registry.ts'
import { linuxInstall } from '../platform/linuxPackage.ts'

export interface WindowClaim { pid: number; environment: string; name?: string; socket: string; pending?: boolean; at: number }
type Request = { type: 'focus' } | { type: 'ping' } | { type: 'quit' }
export interface WindowReply { ok: boolean; pid: number; environment: string; focused: number }
export type OpenResult = { action: 'self' | 'focused' | 'opened'; pid: number }

const dir = () => path.join(configDir(), 'gpuix-windows')
const claimFile = (pid: number) => path.join(dir(), `${pid}.json`)
/**
 * Unix socket paths are limited to 104 bytes on macOS; long config dirs fall back to a hashed tmp path.
 * Windows has no socket files for Node's `net`: the endpoint is a named pipe keyed by the config dir and pid.
 */
export function socketPath(pid: number, platform: NodeJS.Platform = process.platform) {
  if (platform === 'win32') return `\\\\.\\pipe\\kybern-gpuix-${createHash('sha1').update(dir()).digest('hex').slice(0, 12)}-${pid}`
  const inside = path.join(dir(), `${pid}.sock`)
  if (Buffer.byteLength(inside) < 100) return inside
  return path.join(tmpdir(), `kybern-gpuix-${createHash('sha1').update(dir()).digest('hex').slice(0, 12)}-${pid}.sock`)
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }

function writeClaim(claim: WindowClaim) {
  mkdirSync(dir(), { recursive: true, mode: 0o700 })
  const file = claimFile(claim.pid), temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(claim), { mode: 0o600 })
  renameSync(temp, file)
}
function dropClaim(pid: number) { rmSync(claimFile(pid), { force: true }) }

/** Live window claims; claims of exited processes are removed on the way. */
export function windowClaims(): WindowClaim[] {
  let names: string[]
  try { names = readdirSync(dir()) } catch { return [] }
  const claims: WindowClaim[] = []
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue
    try {
      const claim = JSON.parse(readFileSync(path.join(dir(), name), 'utf8')) as WindowClaim
      if (alive(claim.pid)) claims.push(claim)
      else { dropClaim(claim.pid); rmSync(claim.socket, { force: true }) }
    } catch { /* A claim being rewritten; the next read sees it. */ }
  }
  return claims
}

/** One request over a window's socket. Null when nothing answers (an exited or still-starting window). */
export function askWindow(claim: Pick<WindowClaim, 'socket'>, request: Request, timeoutMs = 1500): Promise<WindowReply | null> {
  return new Promise(resolve => {
    const socket = connect(claim.socket)
    let buffer = ''
    const done = (reply: WindowReply | null) => { clearTimeout(timer); socket.destroy(); resolve(reply) }
    const timer = setTimeout(() => done(null), timeoutMs)
    socket.setEncoding('utf8')
    socket.once('error', () => done(null))
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', chunk => {
      buffer += chunk
      const line = buffer.indexOf('\n')
      if (line < 0) return
      try { done(JSON.parse(buffer.slice(0, line)) as WindowReply) } catch { done(null) }
    })
  })
}

/** A spawned window answers once its socket is up; wait while its process lives. */
async function askStarting(claim: WindowClaim, request: Request, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && alive(claim.pid)) {
    const reply = await askWindow(claim, request, 1000)
    if (reply) return reply
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return null
}

interface Host { environment: () => { id: string; name: string }; focus: () => void; /** Leave the app; the process exit flushes persisted state. */ quit?: () => void }
let host: Host | null = null
let server: Server | null = null
let focusCount = 0

/** Claim this process's window and answer focus requests from sibling windows. */
export function startWindowRegistry(next: Host) {
  if (server) return
  host = next
  mkdirSync(dir(), { recursive: true, mode: 0o700 })
  const socket = socketPath(process.pid)
  rmSync(socket, { force: true })
  server = createServer(connection => {
    let buffer = ''
    connection.setEncoding('utf8')
    connection.on('error', () => {})
    connection.on('data', chunk => {
      buffer += chunk
      const line = buffer.indexOf('\n')
      if (line < 0) { if (buffer.length > 4096) connection.destroy(); return }
      let request: Request | null = null
      try { request = JSON.parse(buffer.slice(0, line)) as Request } catch { /* answered as not ok */ }
      if (request?.type === 'focus') { focusCount++; host!.focus() }
      const reply: WindowReply = { ok: !!request, pid: process.pid, environment: host!.environment().id, focused: focusCount }
      // Answer first so the asker sees the request was taken, then leave.
      connection.end(`${JSON.stringify(reply)}\n`, () => { if (request?.type === 'quit') (host!.quit ?? (() => process.exit(0)))() })
    })
  })
  server.on('error', error => console.error('[windows] registry socket:', error))
  server.listen(socket, () => publishWindow())
  server.unref()
  process.once('exit', () => { dropClaim(process.pid); rmSync(socket, { force: true }) })
}

/** Rewrite this window's claim (after launch and on every environment switch). */
export function publishWindow() {
  if (!host || !server?.listening) return
  const { id, name } = host.environment()
  writeClaim({ pid: process.pid, environment: id, name, socket: socketPath(process.pid), at: Date.now() })
}

/**
 * Ask every other window process to quit and wait for them to exit. The Windows updater calls this before
 * it starts the installer: each environment window is its own process and keeps the install's executables
 * and DLLs open. Returns the pids still running when the wait ends (the installer then moves their files
 * aside as `.old`, and those windows keep running the old version until they are closed).
 */
export async function quitOtherWindows(timeoutMs = 10000): Promise<number[]> {
  const others = windowClaims().filter(claim => claim.pid !== process.pid)
  await Promise.all(others.map(claim => askWindow(claim, { type: 'quit' }, 2000)))
  const deadline = Date.now() + timeoutMs
  let running = others.filter(claim => alive(claim.pid))
  while (running.length && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
    running = running.filter(claim => alive(claim.pid))
  }
  return running.map(claim => claim.pid)
}

/**
 * The process that becomes a window pinned to `id`: the same entry point, environment fixed by `KYBERN_GPUIX_ENVIRONMENT`.
 * An AppImage starts the image itself: this process's mount goes away when it quits, and the new window would lose its files.
 */
export function spawnEnvironmentWindow(id: string) {
  const args = process.env.KYBERN_GPUIX_RESOURCES ? [] : [fileURLToPath(new URL('../main.tsx', import.meta.url))]
  const install = linuxInstall()
  const env: NodeJS.ProcessEnv = { ...process.env, KYBERN_GPUIX_ENVIRONMENT: id, KYBERN_GPUIX_THREAD: '' }
  if (install?.kind === 'appimage') for (const name of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD']) delete env[name]
  // No `windowsHide`: the child is the GUI app (no console to hide), and Windows would hide its window.
  const child = spawn(install?.kind === 'appimage' ? install.image : process.execPath, args, { detached: true, stdio: 'ignore', env })
  child.unref()
  if (!child.pid) throw Error('Unable to open window. Reopen Kybern and try again.')
  return child.pid
}

let queue: Promise<unknown> = Promise.resolve()
/**
 * Show `id` in its own window: this one if it already shows it, the window that does, or a new one.
 * Calls are serialized, so a double click opens one window.
 */
export function openWindowFor(id: string, open = spawnEnvironmentWindow): Promise<OpenResult> {
  const run = async (): Promise<OpenResult> => {
    if (host?.environment().id === id) { host.focus(); return { action: 'self', pid: process.pid } }
    for (const claim of windowClaims()) {
      if (claim.environment !== id || claim.pid === process.pid) continue
      const reply = claim.pending ? await askStarting(claim, { type: 'focus' }, 15000) : await askWindow(claim, { type: 'focus' })
      // It may have switched to another environment since it claimed this one.
      if (reply?.ok && reply.environment === id) return { action: 'focused', pid: claim.pid }
      if (!reply && !claim.pending) { dropClaim(claim.pid) }
    }
    const pid = open(id)
    writeClaim({ pid, environment: id, socket: socketPath(pid), pending: true, at: Date.now() })
    return { action: 'opened', pid }
  }
  const next = queue.then(run, run)
  queue = next.catch(() => {})
  return next
}
