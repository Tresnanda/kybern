// The local shell owns startup, not the WebSocket transport. Mirrors
// desktop/src-tauri/src/lib.rs, including the pre-recovery announcement.
import { existsSync, closeSync, openSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Endpoint } from '../../../../packages/kybern-client/src/client.ts'
import { PROTOCOL_VERSION, type DaemonInfo } from '../../../../packages/kybern-client/src/types.ts'
import { normalizeDaemonUrl } from '../../../../packages/kybern-client/src/address.ts'

export function desktopVersion() {
  if (process.env.KYBERN_GPUIX_VERSION) return process.env.KYBERN_GPUIX_VERSION
  const manifest = readFileSync(new URL('../../../../Cargo.toml', import.meta.url), 'utf8')
  const version = /\[workspace\.package\]\s*\nversion\s*=\s*"([^"]+)"/.exec(manifest)?.[1]
  if (!version) throw Error('This build is missing its desktop version')
  return version
}

export function bundledCommand(name: 'kybern' | 'kybernd') {
  const explicit = process.env[name === 'kybern' ? 'KYBERN_BUNDLED_CLI' : 'KYBERND']
  const candidates = [explicit, path.join(path.dirname(process.execPath), name),
    // Development builds use this checkout's artifacts only.
    fileURLToPath(new URL(`../../../../target/debug/${name}`, import.meta.url)),
    ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, name))]
  return candidates.find((candidate): candidate is string => !!candidate && existsSync(candidate) && statSync(candidate).isFile())
}

export function daemonNeedsRestart(info: Pick<DaemonInfo, 'protocol_version' | 'version' | 'started_at'>, version: string, modifiedMs?: number) {
  return info.protocol_version !== PROTOCOL_VERSION || info.version !== version || (modifiedMs !== undefined && modifiedMs > Date.parse(info.started_at))
}
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
export interface LocalDaemonOptions { root: string; url?: string; token?: string; binary?: string; version?: string; port?: string }
export interface DaemonDependencies {
  rpc: typeof daemonRpc
  launch: (binary: string, args: string[], root: string) => Promise<ChildProcess>
  sleep: typeof sleep
  now: () => number
}
let loginPath: Promise<string> | undefined
function daemonPath() {
  return loginPath ??= new Promise<string>(resolve => {
    const fallback = [path.join(homedir(), '.local/bin'), path.join(homedir(), '.cargo/bin'), path.join(homedir(), '.bun/bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH ?? ''].join(path.delimiter)
    if (!process.env.SHELL) return resolve(fallback)
    execFile(process.env.SHELL, ['-ilc', 'printf \'%s\' "$PATH"'], { timeout: 5000, maxBuffer: 128 * 1024 }, (error, output) => resolve(!error && output.trim() ? `${output.trim()}${path.delimiter}${fallback}` : fallback))
  })
}
const defaults: DaemonDependencies = {
  rpc: daemonRpc, sleep, now: Date.now,
  launch: async (binary, args, root) => {
    const log = openSync(path.join(root, 'daemon.log'), 'a', 0o600)
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: await daemonPath() }
      delete env.CARGO_TARGET_DIR
      const child = spawn(binary, args, { detached: true, stdio: ['ignore', log, log], env })
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
  const info = (endpoint: Endpoint) => deps.rpc<DaemonInfo>(endpoint, 'daemon.info').catch(() => null)
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
    const existing = endpoint && await info(endpoint)
    if (configured) {
      if (!existing) throw Error('The daemon configured by KYBERN_URL is not reachable or rejected the configured token')
      if (existing.protocol_version !== PROTOCOL_VERSION) throw Error('This environment uses an incompatible protocol. Update Kybern on the client and host')
      return endpoint!
    }
    const binary = options.binary ?? bundledCommand('kybernd')
    if (!binary) throw Error('kybernd not found next to the app or on PATH. Install the daemon, then reconnect.')
    const version = options.version ?? desktopVersion()
    const port = options.port === undefined ? await preferredDaemonPort(root) : Number(options.port)
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Set KYBERN_PORT to a port between 0 and 65535')
    await mkdir(root, { recursive: true })
    if (port) await writeFile(path.join(root, 'desktop.port'), String(port))
    if (existing) {
      if (!daemonNeedsRestart(existing, version, statSync(binary).mtimeMs)) return endpoint!
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
