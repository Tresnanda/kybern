// Bun counterpart of desktop/src-tauri/src/remote.rs. Never passes secrets in argv.
import { spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { createServer, connect } from 'node:net'
import path from 'node:path'
import { bootstrapPlan, compareVersions, parseSshTarget, sshConfigHosts, tunnelPlan, type CommandPlan, type SshConfig } from '../shell/platform.ts'
import type { EnvironmentProfile } from './registry.ts'

export type BootstrapStep = 'connect' | 'install' | 'start' | 'pair'
export interface BootstrapProgress { step: BootstrapStep; state: 'running' | 'done' | 'failed'; detail?: string }
export interface BootstrapInput { id?: string; name: string; target: string; data_dir?: string }
export type SavedSsh = NonNullable<EnvironmentProfile['ssh']>
export const toConfig = (ssh: SavedSsh): SshConfig => ({ target: ssh.target, port: ssh.port, remotePort: ssh.remote_port, localPort: ssh.local_port, dataDir: ssh.data_dir ?? undefined })
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export async function listSshHosts(file = path.join(homedir(), '.ssh/config')) {
  try { return sshConfigHosts(await readFile(file, 'utf8')) } catch { return [] }
}
function explain(target: string, detail: string) {
  if (/Permission denied/.test(detail)) return `SSH could not sign in to ${target} without a password. Copy your key there with ssh-copy-id ${target} or load it in ssh-agent, then try again.`
  if (/HOST IDENTIFICATION HAS CHANGED|Host key verification failed/.test(detail)) return `The SSH host key for ${target} changed. Verify the machine, then remove its old entry from ~/.ssh/known_hosts.`
  return `Unable to connect to ${target} over SSH. Check the machine, SSH keys, and network, then try again.`
}
/** Bounded stdout/stderr, timeout and process-owned cleanup. stdout may hold the bootstrap token. */
export function runSsh(plan: CommandPlan, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.KYBERN_SSH ?? plan.command, plan.args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', detail = '', overflow = false
    const abort = () => { child.kill('SIGTERM'); reject(Error('SSH setup was canceled.')) }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(Error('The SSH command timed out. Check the machine and try again.')) }, plan.timeoutMs ?? 45000)
    child.stdout.on('data', chunk => { output += String(chunk); if (output.length > 1024 * 1024) { overflow = true; child.kill() } })
    child.stderr.on('data', chunk => { detail = (detail + String(chunk)).slice(-8192) })
    child.once('error', () => { signal?.removeEventListener('abort', abort); clearTimeout(timer); reject(Error('Start ssh; install OpenSSH and make sure ssh is on PATH.')) })
    child.once('exit', code => { signal?.removeEventListener('abort', abort); clearTimeout(timer); if (overflow) reject(Error('The SSH command returned too much output.')); else if (code !== 0) reject(Error(explain(plan.args.at(-2) ?? 'the machine', detail))); else resolve(output) })
    child.stdin.on('error', () => {})
    child.stdin.end(plan.stdin)
  })
}
export async function freeTunnelPort(preferred = 0): Promise<number> {
  const bind = (port: number) => new Promise<number>((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(port, '127.0.0.1', () => { const address = server.address(); server.close(() => resolve(typeof address === 'object' && address ? address.port : 0)) }) })
  try { return await bind(preferred) } catch { return bind(0) }
}
async function accepts(port: number) {
  return new Promise<boolean>(resolve => { const socket = connect(port, '127.0.0.1'); const done = (ok: boolean) => { socket.destroy(); resolve(ok) }; socket.setTimeout(200, () => done(false)); socket.once('error', () => done(false)); socket.once('connect', () => done(true)) })
}
interface Tunnel { config: SavedSsh; port: number; child?: ChildProcess; stopped: boolean; ready: Promise<number>; retry?: ReturnType<typeof setTimeout> }
const tunnels = new Map<string, Tunnel>()
export function stopSshTunnel(id: string) { const tunnel = tunnels.get(id); if (!tunnel) return; tunnel.stopped = true; clearTimeout(tunnel.retry); tunnel.child?.kill(); tunnels.delete(id) }
export function stopSshTunnels(except?: string) { for (const id of tunnels.keys()) if (id !== except) stopSshTunnel(id) }
process.once('exit', () => stopSshTunnels())
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { stopSshTunnels(); process.exit(0) })
/** Fixed local port survives network sleep/reconnect. ControlMaster cannot own the forward. */
export function ensureSshTunnel(id: string, config: SavedSsh): Promise<number> {
  const existing = tunnels.get(id)
  if (existing && JSON.stringify({ ...existing.config, local_port: 0 }) === JSON.stringify({ ...config, local_port: 0 })) return existing.ready
  stopSshTunnel(id)
  const tunnel: Tunnel = { config, port: 0, stopped: false, ready: Promise.resolve(0) }
  tunnels.set(id, tunnel)
  tunnel.ready = (async () => {
    tunnel.port = await freeTunnelPort(config.local_port)
    let backoff = 1000
    const start = async (first: boolean): Promise<number> => {
      if (tunnel.stopped) throw Error('The SSH connection was closed.')
      const plan = tunnelPlan({ ...toConfig(config), localPort: tunnel.port })
      const child = spawn(process.env.KYBERN_SSH ?? plan.command, plan.args, { stdio: ['ignore', 'ignore', 'pipe'] })
      tunnel.child = child
      let failed = false, detail = ''
      child.stderr?.on('data', chunk => { detail = (detail + String(chunk)).slice(-8192) })
      const retry = () => {
        if (failed) return
        failed = true
        if (!tunnel.stopped) { tunnel.retry = setTimeout(() => { void start(false).catch(() => {}) }, backoff); backoff = Math.min(30000, backoff * 2) }
      }
      child.once('error', retry); child.once('exit', retry)
      const deadline = Date.now() + 30000
      while (!failed && !tunnel.stopped && Date.now() < deadline) {
        if (await accepts(tunnel.port)) { backoff = 1000; return tunnel.port }
        await delay(150)
      }
      if (!failed) child.kill()
      if (first) { stopSshTunnel(id); throw Error(explain(config.target, detail)) }
      throw Error('SSH tunnel is reconnecting.')
    }
    return start(true)
  })()
  return tunnel.ready
}
export interface Machine { os?: string; arch?: string; kybernd?: string; version?: string; curl?: string; port?: string; token?: string }
export const parseProbe = (output: string): Machine => Object.fromEntries(output.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).trim()] }))
export interface BootstrapDependencies {
  run: typeof runSsh
  tunnel: typeof ensureSshTunnel
  stop: typeof stopSshTunnel
  info: (port: number, token: string) => Promise<{ version: string; hostname: string; environment_id: string }>
  shutdown: (port: number, token: string) => Promise<void>
  pair: (port: number, token: string, input: BootstrapInput, ssh: SavedSsh, identity: string) => Promise<EnvironmentProfile>
  version: string
  signal?: AbortSignal
  sleep?: typeof delay
}
/** Dependencies make the complete process/network boundary verifiable without any SSH target. */
export async function bootstrapSsh(input: BootstrapInput, report: (progress: BootstrapProgress) => void, deps: BootstrapDependencies) {
  if (!input.name.trim() || input.name.trim().length > 80) throw Error('Enter an environment name of 1–80 characters.')
  const target = parseSshTarget(input.target), id = input.id ?? crypto.randomUUID()
  const ssh: SavedSsh = { ...target, remote_port: 4173, local_port: 0, data_dir: input.data_dir?.trim() || undefined }
  const config = () => toConfig(ssh)
  const plans = () => bootstrapPlan({ ...config(), localPort: ssh.local_port || 1 }, process.env.KYBERN_REMOTE_INSTALL_URL)
  const sleep = deps.sleep ?? delay
  let step: BootstrapStep = 'connect'
  const progress = (state: BootstrapProgress['state'], detail?: string) => { if (state !== 'failed') deps.signal?.throwIfAborted(); report({ step, state, detail }) }
  const probe = async () => parseProbe(await deps.run(plans().probe))
  const abort = () => deps.stop(id)
  deps.signal?.addEventListener('abort', abort, { once: true })
  try {
    progress('running'); let machine = await probe(); progress('done', `${machine.os ?? ''} ${machine.arch ?? ''}`.trim())
    step = 'install'; progress('running')
    const outdated = !!machine.version && compareVersions(machine.version, deps.version) < 0
    if (!machine.kybernd || outdated) {
      if (machine.curl !== '1') throw Error(`curl is not installed on ${ssh.target}; install it and try again.`)
      await deps.run(plans().installIfMissingOrOlder)
      const previous = machine; machine = await probe()
      if (!machine.kybernd) throw Error('The installer finished but kybernd is not on PATH for non-interactive shells.')
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
      progress('done', `Installed kybernd ${machine.version ?? ''}`.trim())
    } else progress('done', `kybernd ${machine.version ?? ''} is installed`.trim())
    step = 'start'; progress('running'); ssh.remote_port = Number(machine.port) || 4173
    const reachable = async () => { if (!machine.token || !machine.port) return null; ssh.remote_port = Number(machine.port); try { return await deps.info(await deps.tunnel(id, ssh), machine.token) } catch { deps.stop(id); return null } }
    let info = await reachable()
    if (!info) {
      deps.stop(id); await deps.run(plans().startIfUnreachable)
      for (let attempt = 0; attempt < 30 && !info; attempt++) { await sleep(1000); machine = await probe(); info = await reachable() }
    }
    if (!info || !machine.token) throw Error(`kybernd did not start on ${ssh.target}. Check ${ssh.data_dir ?? '~/.kybern'}/daemon.log there.`)
    progress('done', `kybernd ${info.version} on ${info.hostname}`)
    step = 'pair'; progress('running'); ssh.local_port = await deps.tunnel(id, ssh)
    deps.signal?.throwIfAborted()
    const profile = await deps.pair(ssh.local_port, machine.token, { ...input, id }, ssh, info.environment_id)
    progress('done'); return profile
  } catch (error) { deps.stop(id); progress('failed', error instanceof Error ? error.message : String(error)); throw error } finally { deps.signal?.removeEventListener('abort', abort) }
}
