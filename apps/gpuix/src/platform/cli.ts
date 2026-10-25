// The `kybern` command ships inside the app beside `kybernd`; installing it puts
// that copy on PATH the way macOS expects, so every app update carries the
// command along. A port of the desktop's `src-tauri/src/cli.rs` (macOS and
// portable Linux link method; same status fields, checks and copy):
//
// - a symlink into the app, in `~/.local/bin` when that is already on PATH,
//   otherwise `/usr/local/bin` (macOS asks for an administrator password there);
// - never overwrites a file that is not a Kybern command or a link to one;
// - "Remove older copy" deletes only another Kybern CLI that comes first on PATH.
//
// Per platform (`cliInstallKind`):
// - macOS and a portable Linux build: the symlink above (always `~/.local/bin` on Linux, no administrator step);
// - Linux AppImage: the bundled copy lives in a mount that changes on every run, so `~/.local/bin/kybern` links the stable copy
//   `packaging/entry-linux.ts` stages outside it (`stageAppImageCommands`), or, when that folder was not writable, the AppImage
//   file itself, whose AppRun runs the bundled `kybern` when it is started under that name (`$ARGV0`);
// - Linux deb and rpm, and the Windows installer: the package owns the command on PATH, so this only reports whether it is there.
//
// Every input is injectable (`CliEnvironment`) so checks run against a scratch
// home and PATH; the app uses the real ones.
import { execFile } from 'node:child_process'
import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { mkdir, open, rename, rm, symlink, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { bundledCommand } from '../shell/daemon.ts'
import { executableName, loginShellPath, osContext, osName, type OsContext } from './os.ts'

const NAME = 'kybern'

export type CliMethod = 'link' | 'copy' | 'path' | 'package' | 'unavailable'
export interface CliStatus {
  method: CliMethod
  bundled: string | null
  target: string | null
  installed: boolean
  needs_admin: boolean
  target_on_path: boolean
  resolved: string | null
  resolved_version: string | null
  shadowed: boolean
  problem: string | null
  home: string | null
}

export interface CliEnvironment {
  /** The command inside this app. */
  bundled: string | null
  home: string | null
  /** The folders a new terminal searches, in order (the login shell's PATH). */
  searchPath: () => Promise<string[]>
  /** `/usr/local/bin`; tests replace it so nothing outside the scratch folder is touched. */
  systemBin: string
  /** The administrator prompt (`osascript … with administrator privileges`); macOS only. */
  adminRun: (script: string, prompt: string) => Promise<void>
  /** How the command reaches PATH. Defaults to `cliInstallKind` of this process. */
  kind?: CliInstallKind
  /** Defaults to this process's platform; tests pass another. */
  platform?: NodeJS.Platform
}

/** Who puts `kybern` on PATH. */
export type CliInstallKind = 'link' | 'appimage' | 'package' | 'installer'
/**
 * `appPath` is the running program. Whether a package owns the command depends on where the app itself is, not where a
 * `kybern` was found: a portable build on a machine with the Tauri deb has `/usr/bin/kybern` on PATH too.
 */
export function cliInstallKind(bundled: string | null, ctx: OsContext = osContext(), appPath: string = process.execPath): CliInstallKind {
  switch (osName(ctx.platform)) {
    case 'macos': return 'link'
    case 'windows': return 'installer'
    case 'linux':
      if (ctx.env.APPIMAGE) return 'appimage'
      // A deb or rpm installs the app under /usr or /opt and links /usr/bin/kybern itself. A development run (bun, node) has no
      // install of its own, so its command's location stands in.
      const own = /^(bun|node)$/.test(path.posix.basename(appPath)) ? bundled : appPath
      return own && /^\/(usr|opt)\//.test(own) ? 'package' : 'link'
  }
}
/** What the Settings row says when the platform's installer or package owns the command. */
export function managedCliCopy(kind: CliInstallKind, ctx: OsContext = osContext()): string | null {
  if (kind === 'installer') return 'The Kybern installer adds the kybern command to your PATH, and updates it with the app.'
  if (kind === 'package') return 'Your package manager installs the kybern command with Kybern, and updates it with the app.'
  return null
}

export function defaultCliEnvironment(): CliEnvironment {
  const ctx = osContext()
  // Packaged builds carry the command in Contents/MacOS (`packaging/entry.ts`), in `bin` beside the program on Windows (the installer
  // puts only that folder on PATH), and in `bin` for a package.
  const found = process.env.KYBERN_BUNDLED_CLI && existsSync(process.env.KYBERN_BUNDLED_CLI) ? process.env.KYBERN_BUNDLED_CLI : bundledCommand('kybern') ?? null
  const bundledCopy = found && path.basename(found, ctx.platform === 'win32' ? '.exe' : '') === NAME ? found : null
  const kind = cliInstallKind(bundledCopy, ctx)
  // An AppImage's own copy sits in a per-run mount; the link must point at the staged copy outside it, or at the AppImage file.
  const mount = ctx.env.APPDIR?.replace(/\/+$/, '')
  const inMount = !bundledCopy || (!!mount && bundledCopy.startsWith(`${mount}/`))
  const appImage = kind === 'appimage' && inMount && ctx.env.APPIMAGE && existsSync(ctx.env.APPIMAGE) ? ctx.env.APPIMAGE : null
  return { bundled: appImage ?? bundledCopy, home: ctx.platform === 'win32' ? ctx.env.USERPROFILE || homedir() || null : process.env.HOME || homedir() || null, searchPath: () => loginShellPath(ctx), systemBin: '/usr/local/bin', adminRun, kind, platform: ctx.platform }
}

const platformOf = (env: CliEnvironment) => env.platform ?? process.platform
const sameFile = (a: string, b: string) => { try { return realpathSync(a) === realpathSync(b) } catch { return false } }
const trimDir = (dir: string, platform: NodeJS.Platform) => platform === 'win32' ? dir.replace(/[\\/]+$/, '').replaceAll('/', '\\').toLowerCase() : dir.replace(/\/+$/, '')
const sameDir = (a: string, b: string, platform: NodeJS.Platform = process.platform) => trimDir(a, platform) === trimDir(b, platform)
const isFile = (file: string) => { try { return statSync(file).isFile() } catch { return false } }
const resolveCommand = (dirs: string[], platform: NodeJS.Platform = process.platform) => dirs.map(dir => path.join(dir, executableName(NAME, platform))).find(isFile) ?? null

/** `kybern --version` prints `kybern X.Y.Z`. Anything else is not our CLI. */
export function cliVersion(file: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, ['--version'], { timeout: 3000, windowsHide: true }, (error, stdout) => {
      const text = String(stdout ?? '').trim()
      resolve(!error && text.startsWith(`${NAME} `) ? text.slice(NAME.length + 1).trim() : null)
    })
  })
}

async function writable(dir: string): Promise<boolean> {
  const probe = path.join(dir, `.kybern-write-test-${process.pid}`)
  try { await (await open(probe, 'wx')).close(); await rm(probe, { force: true }); return true } catch { return false }
}

/** A path inside a read-only or temporary copy of the app, which a link would outlive. */
function unstableLocation(bundled: string): string | null {
  if (process.platform === 'darwin' && (bundled.includes('/AppTranslocation/') || bundled.startsWith('/Volumes/'))) return 'Move Kybern to your Applications folder and open it from there, then install the command.'
  return null
}

function linkTarget(env: CliEnvironment, dirs: string[], bundled: string): string | null {
  if (!env.home) return null
  const homeBin = path.join(env.home, '.local/bin')
  const candidates = [path.join(homeBin, NAME), path.join(env.systemBin, NAME)]
  const existing = candidates.find(candidate => sameFile(candidate, bundled))
  if (existing) return existing
  return dirs.some(dir => sameDir(dir, homeBin)) || platformOf(env) !== 'darwin' ? path.join(homeBin, NAME) : path.join(env.systemBin, NAME)
}

async function needsAdmin(env: CliEnvironment, target: string): Promise<boolean> {
  const dir = path.dirname(target)
  try { if (statSync(dir).isDirectory()) return !(await writable(dir)) } catch { /* Missing: created on demand below the home folder. */ }
  return !(env.home && (dir === env.home || dir.startsWith(`${env.home}/`)))
}

const kindOf = (env: CliEnvironment) => env.kind ?? cliInstallKind(env.bundled, { ...osContext(), platform: platformOf(env) })
const managed = (kind: CliInstallKind) => kind === 'installer' || kind === 'package'

export async function cliStatus(env = defaultCliEnvironment()): Promise<CliStatus> {
  const platform = platformOf(env)
  const dirs = await env.searchPath()
  const resolved = resolveCommand(dirs, platform)
  const status: CliStatus = { method: 'unavailable', bundled: null, target: null, installed: false, needs_admin: false, target_on_path: false, resolved, resolved_version: resolved ? await cliVersion(resolved) : null, shadowed: false, problem: null, home: env.home }
  const kind = kindOf(env)
  if (managed(kind)) {
    // The installer or package put the command on PATH (or did not): nothing here installs or removes it.
    status.method = kind === 'installer' ? 'path' : 'package'
    status.bundled = env.bundled && isFile(env.bundled) ? env.bundled : null
    status.installed = !!status.resolved_version
    status.target = resolved
    status.target_on_path = status.installed
    status.problem = status.installed ? null : kind === 'installer'
      ? 'The kybern command isn’t on your PATH. Run the Kybern installer again, or add the folder holding kybern.exe to PATH.'
      : 'The kybern command isn’t on your PATH. Reinstall the Kybern package, or run kybern from the folder it was installed to.'
    return status
  }
  if (!env.bundled || !isFile(env.bundled)) {
    status.problem = 'This build of Kybern doesn’t include the kybern command.'
    return status
  }
  status.bundled = env.bundled
  status.method = 'link'
  status.problem = unstableLocation(env.bundled)
  const target = linkTarget(env, dirs, env.bundled)
  if (!target) { status.problem = 'Kybern couldn’t find your home folder.'; return status }
  status.installed = sameFile(target, env.bundled)
  status.needs_admin = !status.installed && await needsAdmin(env, target)
  status.target_on_path = dirs.some(dir => sameDir(dir, path.dirname(target), platform))
  status.shadowed = status.installed && !!resolved && !sameFile(resolved, target) && !sameFile(resolved, env.bundled)
  status.target = target
  return status
}

/** Refuse to overwrite a file that is not a Kybern CLI or a link to one. */
async function checkReplaceable(target: string, bundled: string) {
  let link
  try { link = lstatSync(target) } catch { return }
  if (sameFile(target, bundled) || await cliVersion(target)) return
  // A link left behind by a moved or deleted copy of the app.
  if (link.isSymbolicLink() && !existsSync(target) && path.basename(readlinkSync(target)) === NAME) return
  throw Error(`${target} already exists and isn’t Kybern’s command. Rename or remove it, then try again.`)
}

/** Link beside the target, then rename over it, so `kybern` is never missing or half-written. */
async function link(bundled: string, target: string) {
  const dir = path.dirname(target)
  await mkdir(dir, { recursive: true }).catch((error) => { throw Error(`Unable to create ${dir}: ${error.message}`) })
  const staging = path.join(dir, `.kybern-${process.pid}`)
  await rm(staging, { force: true })
  await symlink(bundled, staging).catch((error) => { throw Error(`Unable to link ${target}: ${error.message}`) })
  await rename(staging, target).catch(async (error) => { await rm(staging, { force: true }); throw Error(`Unable to install ${target}: ${error.message}`) })
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/** Run a shell command as an administrator through the standard macOS password prompt. Only macOS asks: elsewhere the link is per user. */
function adminRun(script: string, prompt: string): Promise<void> {
  if (process.platform !== 'darwin') return Promise.reject(Error('Kybern installs the command for your user only, so it needs no administrator. Make ~/.local/bin writable, then try again.'))
  const quote = (text: string) => `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', `do shell script ${quote(script)} with prompt ${quote(prompt)} with administrator privileges`], (error, _stdout, stderr) => {
      if (!error) return resolve()
      if (String(stderr).includes('-128')) return reject(Error('canceled'))
      reject(Error(`Unable to install the command: ${String(stderr).trim()}`))
    })
  })
}

const managedError = (kind: CliInstallKind) => Error(managedCliCopy(kind) ?? 'Kybern doesn’t manage the command here.')
export async function installCli(env = defaultCliEnvironment()): Promise<CliStatus> {
  if (managed(kindOf(env))) throw managedError(kindOf(env))
  const bundled = env.bundled
  if (!bundled || !isFile(bundled)) throw Error('This build of Kybern doesn’t include the kybern command.')
  const problem = unstableLocation(bundled)
  if (problem) throw Error(problem)
  const target = linkTarget(env, await env.searchPath(), bundled)
  if (!target) throw Error('Kybern couldn’t find your home folder.')
  if (!sameFile(target, bundled)) {
    await checkReplaceable(target, bundled)
    if (await needsAdmin(env, target)) {
      const dir = path.dirname(target)
      await env.adminRun(`/bin/mkdir -p ${shellQuote(dir)} && /bin/ln -sfn ${shellQuote(bundled)} ${shellQuote(target)}`, `Kybern wants to add the kybern command to ${dir}.`)
    } else await link(bundled, target)
  }
  return cliStatus(env)
}

export async function uninstallCli(env = defaultCliEnvironment()): Promise<CliStatus> {
  if (managed(kindOf(env))) throw managedError(kindOf(env))
  const bundled = env.bundled
  if (!bundled || !isFile(bundled)) throw Error('This build of Kybern doesn’t include the kybern command.')
  const target = linkTarget(env, await env.searchPath(), bundled)
  if (!target) throw Error('Kybern couldn’t find your home folder.')
  if (sameFile(target, bundled)) {
    if (!(await writable(path.dirname(target)))) await env.adminRun(`/bin/rm -f ${shellQuote(target)}`, `Kybern wants to remove the kybern command from ${path.dirname(target)}.`)
    else await unlink(target).catch((error) => { throw Error(`Unable to remove ${target}: ${error.message}`) })
  }
  return cliStatus(env)
}

/** Remove an older `kybern` that comes first on PATH (cargo, standalone installer). Only ever a Kybern CLI. */
export async function removeOtherCli(file: string, env = defaultCliEnvironment()): Promise<CliStatus> {
  const current = await cliStatus(env)
  if (!current.shadowed || current.resolved !== file) throw Error('That command is no longer first on your PATH. Reopen Settings to check again.')
  if (!(await cliVersion(file))) throw Error(`${file} isn’t a Kybern command, so Kybern left it in place.`)
  await unlink(file).catch((error) => { throw Error(`Unable to remove ${file}: ${error.message}. Remove it from a terminal instead.`) })
  return cliStatus(env)
}
