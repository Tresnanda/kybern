/**
 * remote9: a real SSH machine for the environment checks, without touching the user's SSH setup or data.
 *
 * - A throwaway user-space `sshd` on 127.0.0.1:2299 with its own host key and an authorized_keys of a
 *   scratch key pair. Every session runs `force.sh`, which sets a scratch `HOME` whose `.kybern` is daemon B's
 *   scratch data dir and whose `.local/bin/kybernd` is the installed daemon, so `$HOME/.kybern` can never be
 *   the user's real data dir.
 * - `KYBERN_SSH` is a wrapper that runs the system `ssh -F <scratch config>`: aliases `kybern-remote9`
 *   (ControlMaster auto + ControlPersist, like the user's own config), `remote9-wrongkey` (rejected key) and
 *   `remote9-closed` (nothing listens). `~/.ssh/config`, `~/.ssh/authorized_keys` and system SSH settings are
 *   never read or written.
 * - Daemons A (4305, this Mac) and B (4306, "the remote") use scratch data dirs; credentials go to the real
 *   Keychain under the scratch service `kybern-gpuix-test-remote9`.
 *
 * Import this before `verify9.lib.ts`: it points that driver at these daemons and directories.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { userInfo } from 'node:os'

export const S = '/Users/mymac/projects/ade-gpuix-scratch'
export const SSH_DIR = `${S}/phase2-remote9-ssh`
export const DATA_A = `${S}/phase2-remote9-a`, DATA_B = `${S}/phase2-remote9-b`
export const PORT_A = 4305, PORT_B = 4306, SSHD_PORT = 2299
export const CLIENT = `${S}/phase2-remote9-client`
export const OUT = '/Users/mymac/projects/ade/previews/gpuix/phase2/remote9'
export const KEYCHAIN = 'kybern-gpuix-test-remote9'
const DAEMON = '/Applications/kybern.app/Contents/MacOS/kybernd', CLI = '/Applications/kybern.app/Contents/MacOS/kybern'
for (const dir of [DATA_A, DATA_B, CLIENT, SSH_DIR]) if (!dir.startsWith(`${S}/phase2-remote9`)) throw Error(`${dir} is not a remote9 scratch directory`)

Object.assign(process.env, {
  KYBERN_VERIFY9_A: DATA_A, KYBERN_VERIFY9_B: DATA_B, KYBERN_VERIFY9_PORT_A: String(PORT_A), KYBERN_VERIFY9_PORT_B: String(PORT_B),
  KYBERN_CLIENT_CONFIG_DIR: CLIENT, KYBERN_VERIFY_OUTPUT: OUT, KYBERN_GPUIX_CREDENTIALS_DIR: `${S}/phase2-remote9-unused-creds`,
})
/** App environment for SSH checks: the scratch ssh, its host list, and the real Keychain under the scratch service. */
export const SSH_ENV = { KYBERN_SSH: `${SSH_DIR}/ssh`, KYBERN_SSH_CONFIG: `${SSH_DIR}/ssh_config`, KYBERN_GPUIX_KEYCHAIN_SERVICE: KEYCHAIN, KYBERN_GPUIX_CREDENTIALS_DIR: '' }

export const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
export const listening = (port: number) => new Promise<boolean>(resolve => { const socket = connect(port, '127.0.0.1'); const done = (ok: boolean) => { socket.destroy(); resolve(ok) }; socket.setTimeout(500, () => done(false)); socket.once('error', () => done(false)); socket.once('connect', () => done(true)) })
export async function until(label: string, check: () => boolean | Promise<boolean>, ms = 20000) { const end = Date.now() + ms; while (Date.now() < end) { try { if (await check()) return } catch { /* retry */ } await wait(60) } throw Error(`Timed out: ${label}`) }
export const cli = (data: string, ...args: string[]) => execFileSync(CLI, ['--data-dir', data, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** Keys, configs and the scratch HOME. Idempotent. */
export function prepareSshTarget() {
  if (existsSync(`${SSH_DIR}/sshd_config`)) return
  mkdirSync(`${SSH_DIR}/home/.local/bin`, { recursive: true })
  for (const key of ['host', 'client', 'wrong']) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `remote9-${key}`, '-f', `${SSH_DIR}/${key}_ed25519`])
  writeFileSync(`${SSH_DIR}/authorized_keys`, readFileSync(`${SSH_DIR}/client_ed25519.pub`))
  symlinkSync(DAEMON, `${SSH_DIR}/home/.local/bin/kybernd`)
  symlinkSync(DATA_B, `${SSH_DIR}/home/.kybern`)
  // macOS nohup exits with "can't detach from console" in sessions of a non-root sshd (no audit session), so the
  // start script's `nohup kybernd … &` would fail on this target only. The scratch HOME's bin (first on the
  // script's PATH) ignores SIGHUP the same way. A real macOS or Linux sshd runs the system nohup.
  writeFileSync(`${SSH_DIR}/home/.local/bin/nohup`, '#!/bin/sh\ntrap "" HUP\nexec "$@"\n', { mode: 0o755 })
  const user = userInfo().username
  writeFileSync(`${SSH_DIR}/force.sh`, `#!/bin/sh
# Scratch SSH target: every session runs with a scratch HOME so $HOME/.kybern is never the real data dir.
[ -n "$SSH_ORIGINAL_COMMAND" ] || { echo "interactive sessions are disabled on this test target" >&2; exit 1; }
PATH=/usr/bin:/bin:/usr/sbin:/sbin; export PATH; HOME=${SSH_DIR}/home; export HOME; cd "$HOME"
exec /bin/sh -c "$SSH_ORIGINAL_COMMAND"
`, { mode: 0o755 })
  writeFileSync(`${SSH_DIR}/sshd_config`, [`Port ${SSHD_PORT}`, 'ListenAddress 127.0.0.1', `HostKey ${SSH_DIR}/host_ed25519`, `PidFile ${SSH_DIR}/sshd.pid`, `AuthorizedKeysFile ${SSH_DIR}/authorized_keys`,
    'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'UsePAM no', 'StrictModes no', 'AllowTcpForwarding local', 'PermitTTY no', 'AllowAgentForwarding no', 'X11Forwarding no',
    `ForceCommand ${SSH_DIR}/force.sh`, `AllowUsers ${user}`, ''].join('\n'))
  const host = (alias: string, lines: string[]) => [`Host ${alias}`, ...lines.map(line => `  ${line}`)].join('\n')
  const common = ['HostName 127.0.0.1', `User ${user}`, 'IdentitiesOnly yes', 'IdentityAgent none', `UserKnownHostsFile ${SSH_DIR}/known_hosts`]
  writeFileSync(`${SSH_DIR}/ssh_config`, [
    host('kybern-remote9 remote9-alias', [...common, `Port ${SSHD_PORT}`, `IdentityFile ${SSH_DIR}/client_ed25519`, 'ControlMaster auto', 'ControlPath /tmp/kr9-%C', 'ControlPersist 30']),
    host('remote9-wrongkey', [...common, `Port ${SSHD_PORT}`, `IdentityFile ${SSH_DIR}/wrong_ed25519`]),
    host('remote9-closed', [...common, `Port ${SSHD_PORT - 1}`]),
    host('*.wild', ['User nobody']), ''].join('\n'))
  // The same, two seconds slower per call: holds each setup step on screen long enough to capture it.
  writeFileSync(`${SSH_DIR}/ssh-slow`, `#!/bin/sh\nsleep 2\nexec /usr/bin/ssh -F ${SSH_DIR}/ssh_config "$@"\n`, { mode: 0o755 })
  writeFileSync(`${SSH_DIR}/ssh`, `#!/bin/sh\n# KYBERN_SSH for the remote9 checks: the system ssh with only the scratch config (never ~/.ssh/config).\nexec /usr/bin/ssh -F ${SSH_DIR}/ssh_config "$@"\n`, { mode: 0o755 })
}
export async function startSshd() {
  prepareSshTarget()
  if (await listening(SSHD_PORT)) return
  execFileSync('/usr/sbin/sshd', ['-f', `${SSH_DIR}/sshd_config`, '-E', `${SSH_DIR}/sshd.log`])
  await until('sshd listening', () => listening(SSHD_PORT))
}
export async function stopSshd() {
  try { process.kill(Number(readFileSync(`${SSH_DIR}/sshd.pid`, 'utf8')), 'SIGTERM') } catch { /* not running */ }
  await until('sshd stopped', async () => !(await listening(SSHD_PORT)))
}
/** ssh processes this check owns: tunnels and ControlMaster muxes for the scratch aliases. */
export function sshProcesses(pattern = 'kybern-remote9|/tmp/kr9-') {
  const out = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).stdout.trim()
  return out ? out.split('\n').map(Number).filter(pid => pid !== process.pid) : []
}
export const tunnelPids = () => sshProcesses('ExitOnForwardFailure=yes.*kybern-remote9')
export function stopMasters() { spawnSync(`${SSH_DIR}/ssh`, ['-O', 'exit', 'kybern-remote9'], { stdio: 'ignore' }) }

/** The daemon's current port, when one runs for this data dir (the SSH start step may have put it on another port). */
export async function runningPort(data: string) { try { const port = Number(readFileSync(`${data}/daemon.port`, 'utf8')); return port && await listening(port) ? port : null } catch { return null } }
export async function startDaemon(data: string, port: number) {
  const running = await runningPort(data)
  if (running === port) return
  if (running) await stopDaemon(data, running)
  if (await listening(port)) throw Error(`Port ${port} is taken by another process`)
  mkdirSync(data, { recursive: true })
  const child = Bun.spawn([DAEMON, '--data-dir', data, '--port', String(port)], { stdout: Bun.file(`${data}.log`), stderr: Bun.file(`${data}.log`), stdin: 'ignore' })
  child.unref()
  await until(`daemon on ${port}`, () => listening(port))
}
export async function stopDaemon(data: string, port: number) {
  try { cli(data, 'stop-daemon') } catch { /* already stopped */ }
  await until(`daemon on ${port} stopped`, async () => !(await listening(port)), 30000)
}
/** A project per daemon so each environment has a visible marker. */
export function ensureProject(data: string, name: string) {
  const projects = (JSON.parse(cli(data, 'call', 'projects.list', '{}')) as { projects: { name: string }[] }).projects
  if (projects.some(project => project.name === name)) return
  const dir = `${S}/phase2-remote9-proj/${name}`
  mkdirSync(dir, { recursive: true }); spawnSync('git', ['init', '-q'], { cwd: dir })
  cli(data, 'call', 'projects.add', JSON.stringify({ path: dir, name }))
}
export const keychainHas = (id: string) => spawnSync('security', ['find-generic-password', '-s', KEYCHAIN, '-a', id], { stdio: 'ignore' }).status === 0
export function clearKeychain() { for (let i = 0; i < 50 && spawnSync('security', ['delete-generic-password', '-s', KEYCHAIN], { stdio: 'ignore' }).status === 0; i++); }
export const registry = () => { try { return JSON.parse(readFileSync(`${CLIENT}/environments.json`, 'utf8')) as { selected_id: string; environments: { id: string; name: string; url?: string; environment_id?: string; ssh?: { target: string; port?: number; remote_port: number; local_port: number; data_dir?: string } }[] } } catch { return { selected_id: 'local', environments: [] } } }
export function resetClient() { rmSync(CLIENT, { recursive: true, force: true }); rmSync(`${DATA_A}/gpuix-ui.json`, { force: true }); clearKeychain() }
export const tokens = (data: string) => (JSON.parse(cli(data, 'call', 'access.tokens.list', '{}')) as { tokens: { id: string; label: string }[] }).tokens
