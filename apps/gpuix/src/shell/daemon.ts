// The local shell owns startup, not the WebSocket transport. Mirrors
// desktop/src-tauri/src/lib.rs, including the pre-recovery announcement.
import { existsSync, closeSync, openSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { executableName, pathPlan, withPath } from '../platform/os.ts'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Endpoint } from '../../../../packages/kybern-client/src/client.ts'
import { PROTOCOL_VERSION, type DaemonInfo } from '../../../../packages/kybern-client/src/types.ts'
import { normalizeDaemonUrl } from '../../../../packages/kybern-client/src/address.ts'
import { compareVersions } from './platform.ts'

export function desktopVersion() {
  if (process.env.KYBERN_GPUIX_VERSION) return process.env.KYBERN_GPUIX_VERSION
  const manifest = readFileSync(new URL('../../../../Cargo.toml', import.meta.url), 'utf8')
  const version = /\[workspace\.package\]\s*\nversion\s*=\s*"([^"]+)"/.exec(manifest)?.[1]
  if (!version) throw Error('This build is missing its desktop version')
  return version
}

/**
 * A running AppImage's mount (`$APPDIR`), or null. The mount disappears when the app quits, so neither the daemon, which
 * outlives the app, nor a linked CLI may run from it (`platform/linuxPackage.ts` stages copies outside it).
 */
export function appImageMount(env: NodeJS.ProcessEnv = process.env, execPath?: string) {
  if (!env.APPIMAGE || !env.APPDIR) return null
  const mount = env.APPDIR.replace(/\/+$/, '')
  // Variables inherited from another AppImage's terminal name a mount this process does not run from.
  return execPath === undefined || execPath.startsWith(`${mount}/`) ? mount : null
}
const inMount = (file: string, mount: string | null) => !!mount && (file === mount || file.startsWith(`${mount}/`))

export function bundledCommand(name: 'kybern' | 'kybernd', env: NodeJS.ProcessEnv = process.env, execPath = process.execPath) {
  const explicit = env[name === 'kybern' ? 'KYBERN_BUNDLED_CLI' : 'KYBERND']
  const file = executableName(name, process.platform)
  const mount = appImageMount(env, execPath)
  // An AppImage runs only the copies it staged outside its mount (`KYBERND`, `KYBERN_BUNDLED_CLI`); a missing copy is an
  // error to show, never a reason to run the mounted file or whatever `kybernd` is on PATH.
  const candidates = mount ? [explicit] : [explicit, path.join(path.dirname(execPath), file),
    // The Windows installer keeps the command-line tools in `bin`, the only folder it adds to PATH.
    path.join(path.dirname(execPath), 'bin', file),
    // Development builds use this checkout's artifacts only.
    fileURLToPath(new URL(`../../../../target/debug/${file}`, import.meta.url)),
    ...(env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, file))]
  return candidates.find((candidate): candidate is string => !!candidate && !inMount(candidate, mount) && existsSync(candidate) && statSync(candidate).isFile())
}

/**
 * Variables of this app's own process that mean nothing to the daemon and the agents it starts, and that are wrong for
 * them: an AppImage's mount paths (`APPDIR`, `ARGV0`, `OWD`), the addon and resources of this install, and the
 * locations of the daemon and CLI this app resolved. A daemon started by one install outlives it and is later adopted
 * by another. `KYBERN_BUNDLED_CLI` stays when it names a stable file (askpass falls back to it), never a path in the mount.
 */
const APP_INTERNAL_ENV = ['KYBERN_GPUIX_RESOURCES', 'NAPI_RS_NATIVE_LIBRARY_PATH', 'KYBERN_GPUIX_VERSION', 'KYBERN_GPUIX_NATIVE', 'KYBERND', 'KYBERN_GPUIX_PACKAGED_DAEMON', 'APPIMAGE', 'APPDIR', 'OWD', 'ARGV0']
export function daemonLaunchEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source }
  const mount = appImageMount(source)
  for (const name of APP_INTERNAL_ENV) delete env[name]
  if (env.KYBERN_BUNDLED_CLI && inMount(env.KYBERN_BUNDLED_CLI, mount)) delete env.KYBERN_BUNDLED_CLI
  return env
}

/** Variables a spawned copy of this app must not inherit, so it resolves its own daemon and CLI (`update.ts`, `windows/registry.ts`). */
export const APP_RESOLVED_ENV = ['KYBERND', 'KYBERN_BUNDLED_CLI', 'KYBERN_GPUIX_PACKAGED_DAEMON']
/** The AppImage runtime's own variables; a new image sets them for its own mount. */
export const APPIMAGE_ENV = ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD']
/** The environment a relaunched or spawned copy of the app starts with: this process's, minus what only that copy can resolve. */
export function relaunchEnv(source: NodeJS.ProcessEnv, options: { appImage?: boolean } = {}): NodeJS.ProcessEnv {
  const env = { ...source }
  for (const name of [...APP_RESOLVED_ENV, ...(options.appImage ? APPIMAGE_ENV : [])]) delete env[name]
  return env
}

/**
 * Whether this process may stop a running local daemon to replace it with
 * `binary`. The packaged app keeps the desktop's restart policy for its own
 * bundled kybernd. A development run (bun, a checkout's target/debug/kybernd,
 * a KYBERND override) never stops a daemon it did not start: a fresh checkout
 * build is newer than any running daemon, so the policy would replace the
 * user's own daemon. KYBERN_ALLOW_DAEMON_RESTART=1 opts in. A Linux AppImage
 * runs its daemon from a copy outside the image (`packaging/entry-linux.ts`),
 * which it names in KYBERN_GPUIX_PACKAGED_DAEMON.
 */
export function mayRestartDaemon(binary: string, env: NodeJS.ProcessEnv = process.env, execPath = process.execPath, platform: NodeJS.Platform = process.platform) {
  if (env.KYBERN_ALLOW_DAEMON_RESTART === '1') return true
  // Windows paths ignore case and executables end in `.exe` (`bun.exe`, `kybernd.exe`).
  const windows = platform === 'win32', p = windows ? path.win32 : path.posix
  const fold = (value: string) => windows ? value.toLowerCase() : value
  const runtime = p.basename(fold(execPath), windows ? '.exe' : '')
  const packaged = env.KYBERN_GPUIX_PACKAGED_DAEMON || p.join(p.dirname(execPath), windows ? 'kybernd.exe' : 'kybernd')
  return runtime !== 'bun' && runtime !== 'node' && fold(p.resolve(binary)) === fold(p.resolve(packaged))
}

/**
 * What this app does with the daemon already running in a data folder.
 *
 * - `restart`: the bundled daemon is newer (a higher version) or speaks a newer protocol than the running one, or it
 *   is the same version but was built after the running daemon started (a reinstall or development rebuild).
 * - `keep`: the same daemon.
 * - `newer-daemon`: the running daemon is a higher version on the same protocol. Another, newer install owns this data
 *   folder (a stale deb or rpm, or an old AppImage copy, beside an update). This app talks to it as it is: stopping it
 *   would kill the agents it runs, and the older binary would run against a store the newer one migrated.
 * - `newer-protocol`: the running daemon speaks a newer protocol than this app can. Nothing is restarted; the app asks
 *   the user to update.
 * An unreadable daemon version restarts, which is the state the shell can vouch for.
 */
export type DaemonPlan = 'keep' | 'restart' | 'newer-daemon' | 'newer-protocol'
export function daemonPlan(info: Pick<DaemonInfo, 'protocol_version' | 'version' | 'started_at'>, version: string, modifiedMs?: number): DaemonPlan {
  if (info.protocol_version > PROTOCOL_VERSION) return 'newer-protocol'
  if (info.protocol_version < PROTOCOL_VERSION) return 'restart'
  let order: number
  try { order = compareVersions(version, info.version) } catch { return info.version === version ? 'keep' : 'restart' }
  if (order > 0) return 'restart'
  if (order < 0) return 'newer-daemon'
  return modifiedMs !== undefined && modifiedMs > Date.parse(info.started_at) ? 'restart' : 'keep'
}
export const daemonNeedsRestart = (info: Pick<DaemonInfo, 'protocol_version' | 'version' | 'started_at'>, version: string, modifiedMs?: number) => daemonPlan(info, version, modifiedMs) === 'restart'
export async function preferredDaemonPort(root: string) {
  for (const name of ['daemon.port', 'desktop.port']) {
    let value: string
    try { value = (await readFile(path.join(root, name), 'utf8')).trim() }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    const port = Number(value)
    if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) throw Error(`Invalid port in ${path.join(root, name)}; correct the file before restarting Kybern`)
    return port
  }
  return 0
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
function processAlive(pid: number) { try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' } }
async function startupLock(root: string, deps: Pick<DaemonDependencies, 'now' | 'sleep'>) {
  const file = path.join(root, '.gpuix-startup-lock'), owner = `${process.pid}:${crypto.randomUUID()}`
  const deadline = deps.now() + 15000
  for (;;) {
    try { await writeFile(file, owner, { flag: 'wx', mode: 0o600 }); return async () => { if (await readFile(file, 'utf8').catch(() => '') === owner) await rm(file, { force: true }) } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const saved = await readFile(file, 'utf8').catch(() => ''), pid = Number(saved.split(':')[0])
    if (pid > 0 && !processAlive(pid)) { await rm(file, { force: true }); continue }
    if (!(pid > 0)) {
      const modified = await stat(file).then(value => value.mtimeMs, () => deps.now())
      if (deps.now() - modified > 15000) { await rm(file, { force: true }); continue }
    }
    if (deps.now() >= deadline) throw Error('Another Kybern window is resolving the local daemon. Wait a moment, then reconnect.')
    await deps.sleep(50)
  }
}

/** One authenticated RPC, without a compatible-protocol gate (needed for upgrades). */
export function daemonRpc<T>(endpoint: Endpoint, method: string, timeoutMs = 750): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint.url, { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${endpoint.token}` } } as never)
    let settled = false
    const finish = (error?: Error, value?: T) => { if (settled) return; settled = true; clearTimeout(timer); socket.close(); if (error) reject(error); else resolve(value!) }
    const timer = setTimeout(() => finish(Error('The daemon did not respond in time')), timeoutMs)
    socket.onopen = () => socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }))
    socket.onmessage = event => { try { const response = JSON.parse(String(event.data)); if (response.id === 1) finish(response.error ? Error('The daemon rejected the request') : undefined, response.result) } catch { finish(Error('The daemon returned an invalid response')) } }
    socket.onerror = () => finish(Error('Unable to reach the daemon'))
    socket.onclose = () => finish(Error('The daemon closed the connection'))
  })
}
export interface LocalDaemonOptions { root: string; url?: string; token?: string; binary?: string; version?: string; port?: string; allowRestart?: boolean }
export interface DaemonDependencies {
  rpc: typeof daemonRpc
  launch: (binary: string, args: string[], root: string) => Promise<ChildProcess>
  sleep: typeof sleep
  now: () => number
}
let loginPath: Promise<string> | undefined
/** The PATH the daemon (and the agents it starts) sees: the login shell's on macOS and Linux, the inherited one on Windows (`pathPlan`). */
function daemonPath() {
  return loginPath ??= new Promise<string>(resolve => {
    const plan = pathPlan()
    const fallback = plan.fallback.join(path.delimiter)
    if (!plan.shell) return resolve(fallback)
    execFile(plan.shell.command, plan.shell.args, { timeout: 5000, maxBuffer: 128 * 1024, windowsHide: true }, (error, output) => resolve(!error && output.trim() ? `${output.trim()}${path.delimiter}${fallback}` : fallback))
  })
}
const defaults: DaemonDependencies = {
  rpc: daemonRpc, sleep, now: Date.now,
  launch: async (binary, args, root) => {
    const log = openSync(path.join(root, 'daemon.log'), 'a', 0o600)
    try {
      const env: NodeJS.ProcessEnv = withPath(daemonLaunchEnv(process.env), await daemonPath())
      delete env.CARGO_TARGET_DIR
      const child = spawn(binary, args, { detached: true, stdio: ['ignore', log, log], env, windowsHide: true })
      // Handle asynchronous spawn failure; never leave an unhandled error event.
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
      child.unref()
      return child
    } finally { closeSync(log) }
  },
}
export function createLocalDaemonResolver(options: LocalDaemonOptions, dependencies: Partial<DaemonDependencies> = {}) {
  const deps = { ...defaults, ...dependencies }
  let resolving: Promise<Endpoint> | undefined
  let starting: { endpoint: Endpoint; at: number; child: ChildProcess } | undefined
  const info = (endpoint: Endpoint, timeoutMs?: number) => deps.rpc<DaemonInfo>(endpoint, 'daemon.info', timeoutMs).catch(() => null)
  async function resolve(): Promise<Endpoint> {
    if (starting && deps.now() - starting.at < 10000) {
      if (starting.child.exitCode !== null || starting.child.signalCode !== null) { starting = undefined; throw Error('kybernd exited during startup. Check daemon.log and reconnect.') }
      return starting.endpoint
    }
    starting = undefined
    const { root } = options
    const configured = options.url !== undefined
    // Separate GPUIX window processes share startup ownership. An announcement
    // may precede daemon.port while the existing daemon recovers its agents.
    if (!configured) {
      try {
        const pending = JSON.parse(await readFile(path.join(root, '.gpuix-starting.json'), 'utf8')) as { port: number; pid: number; at: number }
        if (deps.now() - pending.at < 10000 && pending.at <= deps.now() && Number.isInteger(pending.port) && pending.port > 0 && pending.port < 65536 && pending.pid > 0 && processAlive(pending.pid)) return { url: `ws://127.0.0.1:${pending.port}/ws`, token: (await readFile(path.join(root, 'daemon.token'), 'utf8')).trim() }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
    }
    let endpoint: Endpoint | undefined
    if (configured) {
      if (!options.token) throw Error('Set KYBERN_TOKEN for the daemon configured by KYBERN_URL')
      endpoint = { url: normalizeDaemonUrl(options.url!), token: options.token }
    } else {
      try { const port = await preferredDaemonPort(root); if (port) endpoint = { url: `ws://127.0.0.1:${port}/ws`, token: (await readFile(path.join(root, 'daemon.token'), 'utf8')).trim() } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    // A busy local daemon or a slow first frame (software rendering) can miss the quick probe. Starting a second
    // daemon then fails on the held port, so ask once more, patiently; nothing listening still fails at once.
    const existing = endpoint && (await info(endpoint) ?? (configured ? null : await info(endpoint, 5000)))
    if (configured) {
      if (!existing) throw Error('The daemon configured by KYBERN_URL is not reachable or rejected the configured token')
      if (existing.protocol_version !== PROTOCOL_VERSION) throw Error('This environment uses an incompatible protocol. Update Kybern on the client and host')
      return endpoint!
    }
    const binary = options.binary ?? bundledCommand('kybernd')
    if (!binary) throw Error(appImageMount(process.env, process.execPath)
      ? 'Kybern couldn’t copy its daemon out of the AppImage. Make ~/.local/share/kybern-gpuix writable or free some disk space, then reopen the app.'
      : 'kybernd not found next to the app or on PATH. Install the daemon, then reconnect.')
    const version = options.version ?? desktopVersion()
    const port = options.port === undefined ? await preferredDaemonPort(root) : Number(options.port)
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Set KYBERN_PORT to a port between 0 and 65535')
    await mkdir(root, { recursive: true })
    if (port) await writeFile(path.join(root, 'desktop.port'), String(port))
    if (existing) {
      const plan = daemonPlan(existing, version, statSync(binary).mtimeMs)
      if (plan === 'keep') return endpoint!
      if (plan === 'newer-protocol') throw Error(`A newer Kybern is running in ${root} (kybernd ${existing.version}). Update this copy of Kybern, or quit the newer one and reopen this app.`)
      if (plan === 'newer-daemon') {
        console.error(`[daemon] ${root}: keeping kybernd ${existing.version}, newer than this app's ${version}; update this copy of Kybern`)
        return endpoint!
      }
      if (!(options.allowRestart ?? mayRestartDaemon(binary))) {
        if (existing.protocol_version !== PROTOCOL_VERSION) throw Error(`The daemon in ${root} uses another protocol. Restart it yourself, or set KYBERN_ALLOW_DAEMON_RESTART=1 to let this development build replace it.`)
        console.error(`[daemon] ${root}: keeping kybernd ${existing.version} (this development build does not restart daemons it did not start; set KYBERN_ALLOW_DAEMON_RESTART=1 to allow it)`)
        return endpoint!
      }
      await deps.rpc(endpoint!, 'daemon.shutdown', 2000)
      const deadline = deps.now() + 30000
      while (existsSync(path.join(root, 'daemon.port')) || existsSync(path.join(root, 'daemon.listen')) || await info(endpoint!)) {
        if (deps.now() >= deadline) throw Error('The old daemon is still shutting down; wait for its agents to close, then reconnect')
        await deps.sleep(50)
      }
    }
    const id = `${process.pid}-${crypto.randomUUID()}`, announcement = path.join(root, `.desktop-startup-${id}.json`)
    const child = await deps.launch(binary, ['--data-dir', root, '--port', String(port), '--desktop-startup-id', id], root)
    try {
      const deadline = deps.now() + 10000
      while (deps.now() < deadline) {
        try {
          const data = JSON.parse(await readFile(announcement, 'utf8')) as { port: number; protocol_version: number }
          if (!Number.isInteger(data.port) || data.port < 1 || data.port > 65535) throw Error('kybernd announced an invalid startup port')
          if (data.protocol_version !== PROTOCOL_VERSION) throw Error('The bundled daemon uses an incompatible protocol. Update this installation.')
          const token = (await readFile(path.join(root, 'daemon.token'), 'utf8')).trim()
          if (!token) throw Error('kybernd did not publish an authentication token')
          const endpoint = { url: `ws://127.0.0.1:${data.port}/ws`, token }
          await writeFile(path.join(root, 'desktop.port'), String(data.port))
          starting = { endpoint, at: deps.now(), child }
          if (child.pid) await writeFile(path.join(root, '.gpuix-starting.json'), JSON.stringify({ port: data.port, pid: child.pid, at: starting.at }), { mode: 0o600 })
          return endpoint
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
        if (child.exitCode !== null || child.signalCode !== null) throw Error('kybernd exited before announcing its startup endpoint. Check daemon.log and reconnect.')
        await deps.sleep(10)
      }
      throw Error('kybernd did not announce its startup endpoint in time. Check daemon.log and reconnect.')
    } finally { await rm(announcement, { force: true }) }
  }
  return () => resolving ??= (async () => {
    if (options.url !== undefined) return resolve()
    await mkdir(options.root, { recursive: true })
    const unlock = await startupLock(options.root, deps)
    try { return await resolve() } finally { await unlock() }
  })().finally(() => { resolving = undefined })
}
