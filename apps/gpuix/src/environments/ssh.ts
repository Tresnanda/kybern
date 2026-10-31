// Bun counterpart of desktop/src-tauri/src/remote.rs. Never passes secrets in argv.
import { spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { createServer, connect } from 'node:net'
import path from 'node:path'
import { bootstrapPlan, networkBootstrapPlan, compareVersions, parseSshTarget, sshConfigHosts, tunnelPlan, type CommandPlan, type SshConfig } from '../shell/platform.ts'
import type { EnvironmentProfile } from './registry.ts'

export type BootstrapStep = 'connect' | 'install' | 'start' | 'pair'
export interface BootstrapProgress { step: BootstrapStep; state: 'running' | 'done' | 'failed'; detail?: string }
export interface BootstrapInput {
  id?: string; name: string; target: string; data_dir?: string
  /** Network setup only probes/connects automatically; installing requires an explicit button. */
  network_setup?: 'connect' | 'install'
  expectedIdentity?: string
}
export class MissingDaemon extends Error {
  constructor() { super('Kybern is not installed. Choose Install and connect to install its daemon and CLI.'); this.name = 'MissingDaemon' }
}
export interface BootstrapResult { machineId: string; name: string; networkEnabled?: boolean }
export type SavedSsh = NonNullable<EnvironmentProfile['ssh']>
export const toConfig = (ssh: SavedSsh): SshConfig => ({ target: ssh.target, port: ssh.port, remotePort: ssh.remote_port, localPort: ssh.local_port, dataDir: ssh.data_dir ?? undefined })
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export async function listSshHosts(file = path.join(homedir(), '.ssh/config')) {
  try { return sshConfigHosts(await readFile(file, 'utf8')) } catch { return [] }
}
/** `explain_ssh_failure` in remote.rs, word for word. */
export function explain(target: string, code: number | null, stderr: string) {
  const host = target.split('@').at(-1) ?? target, detail = stderr.trim()
  if (/sh.*(not found|not recognized)|not recognized.*sh/i.test(detail)) return 'This SSH account uses a Windows shell. Install Kybern with the release’s kybern-installer.ps1, configure a persistent Windows service, then add its pairing invitation. Automatic Windows SSH installation is not supported.'
  if (detail.includes('Permission denied')) return `SSH could not sign in to ${target} without a password. Copy your key there with \`ssh-copy-id ${target}\` or load it in ssh-agent, then try again`
  if (/Could not resolve hostname|Name or service not known/.test(detail)) return `Unable to resolve ${host}. Check the address`
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/.test(detail)) return `The SSH host key for ${host} changed. Verify the machine, then remove its old entry from ~/.ssh/known_hosts`
  if (/Connection refused|timed out|No route to host/.test(detail)) return `Unable to reach ${target} over SSH. Check that the machine is on and its SSH port is open`
  const last = detail.split('\n').reverse().find(line => line.trim())?.trim() ?? ''
  if (code === 255) return last ? `SSH to ${target} failed: ${last}` : `SSH to ${target} failed`
  if (!last) return code === null ? `The command on ${target} was killed by a signal` : `The command on ${target} exited with status ${code} and no output`
  return `${target}: ${last}`
}
/** Bounded stdout/stderr, timeout and process-owned cleanup. stdout may hold the bootstrap token. */
export function runSsh(plan: CommandPlan, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return Promise.reject(Error('SSH setup was canceled.'))
  const target = plan.args.at(-2) ?? 'the machine'
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.KYBERN_SSH ?? plan.command, plan.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let output = '', detail = '', overflow = false, settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error: Error | null) => { if (settled) return; settled = true; signal?.removeEventListener('abort', abort); clearTimeout(timer); if (error) reject(error); else resolve(output) }
    const abort = () => { child.kill('SIGTERM'); finish(Error('SSH setup was canceled.')) }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) { abort(); return }
    const timeoutMs = plan.timeoutMs ?? 45000
    timer = setTimeout(() => { child.kill('SIGTERM'); finish(Error(`${target} did not answer within ${Math.round(timeoutMs / 1000)} seconds`)) }, timeoutMs)
    child.stdout.on('data', chunk => { output += String(chunk); if (output.length > 1024 * 1024) { overflow = true; child.kill() } })
    child.stderr.on('data', chunk => { detail = (detail + String(chunk)).slice(-8192) })
    child.once('error', () => finish(Error('Start ssh; install OpenSSH and make sure `ssh` is on PATH')))
    // `exit` can arrive before the last stdout chunk; wait for the pipe to end. A
    // ControlPersist master that kept a pipe open must not hold the step, so cap it.
    const ended = new Promise<void>(done => { child.stdout.once('end', done); child.stdout.once('close', done) })
    child.once('exit', code => {
      void Promise.race([ended, delay(500)]).then(() => {
        if (overflow) finish(Error('The SSH command returned too much output.'))
        else if (code !== 0) finish(Error(explain(target, code, detail)))
        else finish(null)
      })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(plan.stdin)
  })
}
export async function freeTunnelPort(preferred = 0): Promise<number> {
  const bind = (port: number) => new Promise<number>((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(port, '127.0.0.1', () => { const address = server.address(); server.close(() => resolve(typeof address === 'object' && address ? address.port : 0)) }) })
  try { if (preferred) return await bind(preferred) } catch { /* taken: any free port */ }
  return bind(0)
}
async function accepts(port: number) {
  return new Promise<boolean>(resolve => { const socket = connect(port, '127.0.0.1'); const done = (ok: boolean) => { socket.destroy(); resolve(ok) }; socket.setTimeout(1000, () => done(false)); socket.once('error', () => done(false)); socket.once('connect', () => done(true)) })
}
/** remote.rs `TunnelStatus`: the keeper's view, read by `waitReady`. */
type TunnelStatus = { state: 'starting' } | { state: 'ready' } | { state: 'failed'; error: string }
interface Tunnel { config: SavedSsh; port: number; child?: ChildProcess; stopped: boolean; status: TunnelStatus; wake?: () => void; retry?: ReturnType<typeof setTimeout> }
const tunnels = new Map<string, Tunnel>()
export function stopSshTunnel(id: string) { const tunnel = tunnels.get(id); if (!tunnel) return; tunnel.stopped = true; clearTimeout(tunnel.retry); tunnel.wake?.(); tunnel.child?.kill(); tunnels.delete(id) }
export function stopSshTunnels(except?: string) { for (const id of tunnels.keys()) if (id !== except) stopSshTunnel(id) }
/** For checks: the tunnel's state and its ssh child, so a test can cut the connection. */
export const sshTunnelState = (id: string) => { const tunnel = tunnels.get(id); return tunnel && { port: tunnel.port, status: tunnel.status, pid: tunnel.child?.pid } }
process.once('exit', () => stopSshTunnels())
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { stopSshTunnels(); process.exit(0) })

/** remote.rs `spawn_tunnel`: `ssh -N -L`, resolved once the local port accepts (ssh listens only after it authenticated). */
async function spawnTunnel(tunnel: Tunnel): Promise<ChildProcess> {
  const { config, port } = tunnel
  const plan = tunnelPlan({ ...toConfig(config), localPort: port })
  const child = spawn(process.env.KYBERN_SSH ?? plan.command, plan.args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  tunnel.child = child
  let detail = '', exit: { code: number | null } | null = null
  child.stderr?.on('data', chunk => { detail = (detail + String(chunk)).slice(-8192) })
  const exited = new Promise<void>(done => { child.once('error', () => { exit ??= { code: null }; done() }); child.once('exit', code => { exit ??= { code }; done() }) })
  const deadline = Date.now() + 30000
  for (;;) {
    if (exit) { await Promise.race([new Promise(done => child.stderr?.once('end', done)), delay(200)]); throw Error(explain(config.target, (exit as { code: number | null }).code, detail)) }
    if (tunnel.stopped) { child.kill(); throw Error('The SSH connection was closed.') }
    if (await accepts(port)) return child
    if (Date.now() >= deadline) { child.kill(); await exited; throw Error(`The SSH tunnel to ${config.target} did not open within 30 seconds`) }
    await Promise.race([exited, delay(150)])
  }
}
/** remote.rs `keep_tunnel`: one tunnel on a fixed local port, respawned with 1–30 s backoff until stopped,
 * so the saved `ws://127.0.0.1:<port>/ws` address stays valid across network changes and sleep. */
async function keepTunnel(tunnel: Tunnel) {
  let backoff = 1000
  while (!tunnel.stopped) {
    try {
      const child = await spawnTunnel(tunnel)
      tunnel.status = { state: 'ready' }; backoff = 1000
      await new Promise<void>(done => { if (child.exitCode !== null || child.signalCode !== null) done(); else child.once('exit', () => done()) })
      if (tunnel.stopped) return
      console.warn(`[ssh] tunnel to ${tunnel.config.target} ended; reconnecting`)
      tunnel.status = { state: 'starting' }
    } catch (error) {
      if (tunnel.stopped) return
      tunnel.status = { state: 'failed', error: error instanceof Error ? error.message : String(error) }
    }
    await new Promise<void>(done => { tunnel.wake = done; tunnel.retry = setTimeout(done, backoff) })
    backoff = Math.min(30000, backoff * 2)
  }
}
/** remote.rs `wait_ready`. */
async function waitReady(tunnel: Tunnel): Promise<number> {
  const deadline = Date.now() + 35000
  for (;;) {
    if (tunnel.stopped) throw Error('The SSH connection was closed.')
    if (tunnel.status.state === 'ready') return tunnel.port
    if (tunnel.status.state === 'failed') throw Error(tunnel.status.error)
    if (await accepts(tunnel.port)) return tunnel.port
    if (Date.now() >= deadline) throw Error('The SSH tunnel did not open in time')
    await delay(150)
  }
}
/** remote.rs `ensure_tunnel`: make sure this environment's tunnel is up and return its local port.
 * ControlMaster cannot own the forward (`tunnelPlan` turns multiplexing off for it). */
export async function ensureSshTunnel(id: string, config: SavedSsh): Promise<number> {
  const existing = tunnels.get(id)
  if (existing && existing.config.target === config.target && existing.config.port === config.port && existing.config.remote_port === config.remote_port) return waitReady(existing)
  stopSshTunnel(id)
  const tunnel: Tunnel = { config, port: 0, stopped: false, status: { state: 'starting' } }
  tunnels.set(id, tunnel)
  tunnel.port = await freeTunnelPort(config.local_port)
  void keepTunnel(tunnel)
  return waitReady(tunnel)
}
export interface Machine { os?: string; arch?: string; kybernd?: string; version?: string; curl?: string; port?: string; token?: string }
export const parseProbe = (output: string): Machine => Object.fromEntries(output.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).trim()] }))
export interface BootstrapDependencies {
  run: typeof runSsh
  tunnel: typeof ensureSshTunnel
  stop: typeof stopSshTunnel
  info: (port: number, token: string) => Promise<{ version: string; hostname: string; environment_id: string }>
  shutdown: (port: number, token: string) => Promise<void>
  pair: (port: number, token: string, input: BootstrapInput, ssh: SavedSsh, identity: string) => Promise<BootstrapResult>
  version: string
  signal?: AbortSignal
  sleep?: typeof delay
}
/** Dependencies make the complete process/network boundary verifiable without any SSH target. */
export async function bootstrapSsh(input: BootstrapInput, report: (progress: BootstrapProgress) => void, deps: BootstrapDependencies) {
  if (!input.name.trim() || input.name.trim().length > 80) throw Error('Enter an environment name of 1–80 characters')
  const target = parseSshTarget(input.target), id = input.id ?? crypto.randomUUID()
  const ssh: SavedSsh = { ...target, remote_port: 4173, local_port: 0, data_dir: input.data_dir?.trim() || undefined }
  const config = () => toConfig(ssh)
  const plans = () => input.network_setup
    ? networkBootstrapPlan({ ...config(), localPort: ssh.local_port || 1 }, deps.version)
    : bootstrapPlan({ ...config(), localPort: ssh.local_port || 1 }, process.env.KYBERN_REMOTE_INSTALL_URL)
  const sleep = deps.sleep ?? delay
  let step: BootstrapStep = 'connect'
  const progress = (state: BootstrapProgress['state'], detail?: string) => { if (state !== 'failed') deps.signal?.throwIfAborted(); report({ step, state, detail }) }
  const probe = async () => parseProbe(await deps.run(plans().probe))
  const abort = () => deps.stop(id)
  deps.signal?.addEventListener('abort', abort, { once: true })
  try {
    progress('running'); let machine = await probe(); progress('done', `${machine.os ?? ''} ${machine.arch ?? ''}`.trim())
    if (input.network_setup && !['Linux', 'Darwin'].includes(machine.os ?? '')) throw Error('Automatic SSH setup supports Linux and macOS. On Windows, install kybern-installer.ps1 from the release page, configure a persistent service, then add its pairing invitation.')
    if (input.network_setup === 'connect' && !machine.kybernd) throw new MissingDaemon()
    step = 'install'
    let installed = false
    const outdated = !input.network_setup && !!machine.version && compareVersions(machine.version, deps.version) < 0
    if (!machine.kybernd || outdated) {
      progress('running')
      if (machine.curl !== '1') throw Error(`curl is not installed on ${ssh.target}; install it and try again`)
      await deps.run(plans().installIfMissingOrOlder)
      installed = true
      const previous = machine; machine = await probe()
      if (!machine.kybernd) throw Error(`The installer finished but kybernd is not on PATH for non-interactive shells on ${ssh.target}`)
      if (outdated && previous.token && previous.port) {
        ssh.remote_port = Number(previous.port)
        try {
          const port = await deps.tunnel(id, ssh)
          await deps.shutdown(port, previous.token)
          for (let attempt = 0; attempt < 80; attempt++) {
            try { await deps.info(port, previous.token) } catch { break }
            await sleep(250)
          }
        } finally { deps.stop(id) }
      }
      deps.signal?.throwIfAborted()
      progress('done', outdated ? `Updated kybernd ${previous.version ?? '?'} to ${machine.version ?? ''}` : `Installed kybernd ${machine.version ?? ''}`.trim())
    } else progress('done', `kybernd ${machine.version ?? ''} is installed`.trim())
    step = 'start'; progress('running', 'Checking daemon service'); ssh.remote_port = Number(machine.port) || 4173
    // Like remote.rs, a tunnel that cannot open fails the step; only an unanswered daemon falls through to starting it.
    const reachable = async () => { deps.signal?.throwIfAborted(); if (!machine.token || !machine.port) return null; ssh.remote_port = Number(machine.port); const port = await deps.tunnel(id, ssh); try { return await deps.info(port, machine.token) } catch { deps.stop(id); return null } }
    // A newly installed daemon always gets a persistent service, even if a process
    // happened to answer during installation. Never report nohup as persistent setup.
    if (installed && input.network_setup) { progress('running'); await deps.run(plans().startIfUnreachable) }
    let info = await reachable()
    if (!info) {
      deps.stop(id); progress('running'); await deps.run(plans().startIfUnreachable)
      for (let attempt = 0; attempt < 30 && !info; attempt++) { await sleep(1000); deps.signal?.throwIfAborted(); machine = await probe(); info = await reachable() }
    }
    if (!info || !machine.token) throw Error(`kybernd did not start on ${ssh.target}. Check ${ssh.data_dir ?? '~/.kybern'}/daemon.log there`)
    progress('done', `kybernd ${info.version} on ${info.hostname}`)
    step = 'pair'; progress('running'); ssh.local_port = await deps.tunnel(id, ssh)
    deps.signal?.throwIfAborted()
    const profile = await deps.pair(ssh.local_port, machine.token, { ...input, id }, ssh, info.environment_id)
    progress('done'); return profile
  } catch (error) { deps.stop(id); progress('failed', error instanceof Error ? error.message : String(error)); throw error } finally { deps.signal?.removeEventListener('abort', abort) }
}
