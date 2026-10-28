// App self-update from the release feed and minisign public key in
// `updater.json` (the ones the retired Tauri updater used): checked 15 s after
// launch and every 6 h, announced once per version, installed on request with
// download progress, then relaunched.
// The packaged daemon is restarted by the shell on the next launch because its
// version no longer matches (`shell/daemon.ts`).
//
// What Tauri's updater did natively is done here: fetch `latest.json`, pick
// this build's platform entry, download it, verify the minisign signature
// (`minisign.ts`), unpack the `.app.tar.gz` and swap the bundle in place.
// GPUIX ships as its own bundle (`dev.kybern.gpuix`), so its feed entry is
// `darwin-aarch64-gpuix` (Tauri's `{target}-{bundle}` key form). Only the
// `-gpuix` keys are read; plain keys from older feeds are ignored.
//
// Windows (beta) is a per-user NSIS install (`packaging/windows/installer.nsi`),
// feed key `windows-x86_64-gpuix`. The signed asset is the installer itself: it
// is downloaded, verified, started silently (`/S /UPDATE`) and this process
// quits. Before that the other GPUIX window processes are asked to quit (each
// holds the install's files open; `windows/registry.ts`), and the installer is
// told the folder of this copy (`/D=`). The installer waits for the app to
// exit, replaces the files (a locked daemon is moved aside, not killed) and
// starts the new app with this process's environment. The signature must name
// this release's installer, so a validly signed Tauri setup or an older GPUIX
// installer in the feed is refused. Only an installed copy updates; a loose
// `Kybern GPUIX.exe` has no `uninstall.exe` beside it and stays put.
//
// Linux (`linux-x86_64-gpuix`, the AppImage): a running AppImage replaces its
// own file and relaunches it. Its signature must name exactly this release's
// AppImage (`kybern-gpuix_<version>_x86_64.AppImage`) and a newer version, the
// same check as the Windows installer (`assertSignedRelease`), and the download
// must be an x86-64 type 2 AppImage before it is swapped in. An AppImage whose
// folder the user cannot write, a deb or rpm install, and an unpacked AppImage
// only announce the release with a download link (a package's install command
// too; `linuxPackage.ts` reads which format this is).
//
// Tests point the app at a local feed with KYBERN_UPDATE_FEED (loopback only)
// and KYBERN_UPDATE_PUBKEY; nothing else can change the key.
import { spawn, execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { useSyncExternalStore } from 'react'
import updater from './updater.json'
import { desktopVersion, relaunchEnv } from '../shell/daemon.ts'
import { compareVersions } from '../shell/platform.ts'
import { readPref, writePref } from './prefs.ts'
import { verifyMinisign } from './minisign.ts'
import { installerName } from '../../packaging/windows/lib.ts'
import { quitOtherWindows } from '../windows/registry.ts'
import { appImageName, imageDirWritable, linuxInstall, packageCommand } from './linuxPackage.ts'
import { installedWindowsFolder } from './windowsInstall.ts'

const run = promisify(execFile)

export type AppUpdatePhase = 'idle' | 'checking' | 'current' | 'available' | 'installing' | 'error'
export interface AppUpdateState {
  phase: AppUpdatePhase
  appVersion: string | null
  version: string | null
  notes: string | null
  /** 0–1 while installing; null until the size is known. */
  progress: number | null
  error: string | null
  errorKind: 'check' | 'install' | null
  checkedAt: number | null
  announcementOpen: boolean
  detailsOpen: boolean
  /** A newer release whose feed has no GPUIX build yet (not installable). */
  unpublished: string | null
  /** For a deb or rpm install (or an unpacked AppImage): where to download the release, and the command that installs it. */
  manual: ManualUpdate | null
}
export interface ManualUpdate { url: string; file: string; command: string | null }

let state: AppUpdateState = { phase: 'idle', appVersion: null, version: null, notes: null, progress: null, error: null, errorKind: null, checkedAt: null, announcementOpen: false, detailsOpen: false, unpublished: null, manual: null }
const listeners = new Set<() => void>()
const set = (patch: Partial<AppUpdateState>) => { state = { ...state, ...patch }; for (const l of listeners) l() }
export const getAppUpdate = () => state
export function useAppUpdate<T>(select: (s: AppUpdateState) => T): T {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, () => select(state))
}

const FIRST_CHECK_DELAY = 15_000
const CHECK_INTERVAL = 6 * 60 * 60 * 1000
const DISMISSED_UPDATE_KEY = 'kybern.update.dismissed-version'
/** The feed entry for this build (Tauri's `{os}-{arch}-{bundle}` form). Windows is x64 only. */
export const platformKey = (platform: NodeJS.Platform, arch: string) =>
  platform === 'win32' ? 'windows-x86_64-gpuix' : `${platform === 'linux' ? 'linux' : 'darwin'}-${arch === 'arm64' ? 'aarch64' : 'x86_64'}-gpuix`
export const PLATFORM_KEY = platformKey(process.platform, process.arch)

interface FeedEntry { url: string; signature: string }
interface Pending { version: string; notes: string | null; entry: FeedEntry }
let pending: Pending | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let checkInFlight: Promise<void> | null = null
let installInFlight: Promise<void> | null = null
let dismissedInSession: string | null = null

/** The `.app` this process runs from, or null outside a packaged build. */
export function appBundle(execPath = process.execPath): string | null {
  // Checks against a local feed may name a scratch bundle to replace.
  if (process.env.KYBERN_UPDATE_BUNDLE && testFeed()) return process.env.KYBERN_UPDATE_BUNDLE
  const match = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)
  return match ? match[1]! : null
}

/**
 * The install folder this process runs from on Windows, or null for anything
 * else: a loose copy, `bun`, a build output folder. The installer writes
 * `uninstall.exe` beside the app, which is what marks an installed copy.
 */
export function windowsInstall(execPath = process.execPath, exists: (file: string) => boolean = existsSync): string | null {
  // Checks against a local feed may name a scratch folder to treat as the install.
  if (process.env.KYBERN_UPDATE_BUNDLE && testFeed()) return process.env.KYBERN_UPDATE_BUNDLE
  return installedWindowsFolder(execPath, exists)
}
function testFeed(): URL | null {
  const override = process.env.KYBERN_UPDATE_FEED
  if (!override) return null
  const url = new URL(override)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('KYBERN_UPDATE_FEED must be a loopback http address')
  return url
}

function feed(): { endpoints: string[]; pubkey: string } {
  const local = testFeed()
  if (local) return { endpoints: [local.href], pubkey: process.env.KYBERN_UPDATE_PUBKEY ?? updater.pubkey }
  return { endpoints: updater.endpoints, pubkey: updater.pubkey }
}

/** True when this build can replace itself: a packaged `.app` on macOS, an installed copy on Windows, a running AppImage in a folder its user can write. */
export const canSelfUpdate = (): boolean => process.env.KYBERN_DISABLE_UPDATES !== '1' &&
  (process.platform === 'darwin' ? !!appBundle() : process.platform === 'win32' ? !!windowsInstall() : appImageUpdatable())
function appImageUpdatable(install = linuxInstall(), writable = imageDirWritable) {
  return install?.kind === 'appimage' && writable(install.image)
}
/** True when this build looks for releases: every packaged build. deb and rpm installs only announce them. */
export const canCheckForUpdates = (): boolean => canSelfUpdate() || (process.env.KYBERN_DISABLE_UPDATES !== '1' && linuxInstall() !== null)

/**
 * What a build that cannot replace itself offers instead. The feed carries only
 * the AppImage; the deb and rpm are its release siblings with the same name stem.
 */
export function manualUpdate(entry: FeedEntry, install = linuxInstall(), writable = imageDirWritable): ManualUpdate | null {
  if (!install || (install.kind === 'appimage' && writable(install.image))) return null
  const kind = install.kind === 'unpacked' || install.kind === 'appimage' ? null : install.kind
  const url = kind ? entry.url.replace(/\.AppImage$/, `.${kind}`) : entry.url
  const file = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1))
  return { url, file, command: kind && url !== entry.url ? packageCommand(kind, file) : null }
}

export function loadAppVersion() {
  try { set({ appVersion: desktopVersion() }) } catch { /* About shows an ellipsis instead. */ }
}

/** What to do with a release this build cannot install itself. */
export const manualUpdateText = (manual: ManualUpdate) => manual.command
  ? `Download the package, then run ${manual.command} in the folder it saved to.`
  : 'Download the new AppImage and replace this copy with it.'

/** Ask the release feed for a newer version. */
export function checkForAppUpdate(options: { manual?: boolean } = {}): Promise<void> {
  if (!canCheckForUpdates()) return Promise.resolve()
  if (installInFlight) return installInFlight
  if (checkInFlight) return checkInFlight
  checkInFlight = runUpdateCheck(options).finally(() => { checkInFlight = null })
  return checkInFlight
}

export async function readFeed(current: string, endpoints: string[], fetcher: typeof fetch = fetch): Promise<{ version: string; notes: string | null; entry: FeedEntry | null } | null> {
  let lastError: unknown
  for (const endpoint of endpoints) {
    try {
      const response = await fetcher(endpoint, { signal: AbortSignal.timeout(30_000), headers: { Accept: 'application/json' } })
      if (response.status === 204) return null
      if (!response.ok) throw Error(`release JSON request failed (${response.status})`)
      const data = await response.json() as { version?: unknown; notes?: unknown; platforms?: Record<string, Partial<FeedEntry>> }
      if (typeof data.version !== 'string') throw Error('The update manifest is incomplete. Try again later.')
      const version = data.version.replace(/^v/, '')
      if (compareVersions(version, current) <= 0) return null
      const raw = data.platforms?.[PLATFORM_KEY]
      const entry = raw && typeof raw.url === 'string' && typeof raw.signature === 'string' ? { url: raw.url, signature: raw.signature } : null
      return { version, notes: typeof data.notes === 'string' ? data.notes : null, entry }
    } catch (error) { lastError = error }
  }
  throw lastError
}

async function runUpdateCheck(options: { manual?: boolean }) {
  if (state.phase === 'installing') return
  set({ phase: 'checking', error: null, errorKind: null })
  try {
    const result = await readFeed(desktopVersion(), feed().endpoints)
    if (!result || !result.entry) {
      pending = null
      set({ phase: 'current', version: null, notes: null, checkedAt: Date.now(), announcementOpen: false, detailsOpen: false, unpublished: result?.version ?? null, manual: null })
      return
    }
    pending = { version: result.version, notes: result.notes, entry: result.entry }
    set({ phase: 'available', version: result.version, notes: result.notes, checkedAt: Date.now(), unpublished: null, manual: manualUpdate(result.entry), announcementOpen: dismissedUpdateVersion() !== result.version })
  } catch (error) {
    set({ phase: pending ? 'available' : 'error', error: describe(error), errorKind: 'check', checkedAt: Date.now() })
    if (options.manual) void import('../shell/toasts.tsx').then(({ toast }) => toast.error('Unable to check for updates', { description: describe(error) }))
  }
}

/** Download, verify and install the pending update, then relaunch. A deb or rpm install opens the package's download instead. */
export function installAppUpdate(): Promise<void> {
  if (installInFlight) return installInFlight
  if (state.phase === 'installing') return Promise.resolve()
  if (checkInFlight) return checkInFlight.then(() => installAppUpdate())
  const update = pending
  if (!update) return Promise.resolve()
  if (state.manual) return import('../pulls/PrStates.tsx').then(({ openUrl }) => openUrl(state.manual!.url))
  installInFlight = runUpdateInstall(update).finally(() => { installInFlight = null })
  return installInFlight
}

/** Stream the download, reporting progress like Tauri's Started/Progress/Finished events. */
export async function download(url: string, onProgress: (progress: number | null) => void, fetcher: typeof fetch = fetch): Promise<Uint8Array> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(10 * 60_000) })
  if (!response.ok || !response.body) throw Error(`Download request failed with status: ${response.status}`)
  const length = Number(response.headers.get('content-length'))
  const total = Number.isFinite(length) && length > 0 ? length : null
  onProgress(total === null ? null : 0)
  const chunks: Uint8Array[] = []
  let received = 0
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(chunk)
    received += chunk.length
    if (total !== null) onProgress(Math.max(0, Math.min(1, received / total)))
  }
  onProgress(1)
  return Buffer.concat(chunks)
}

/**
 * Replace `bundle` with the `.app` inside a verified `.app.tar.gz`. Everything
 * is staged beside the bundle (same volume, so both renames are atomic) and the
 * old bundle comes back if the swap fails. The new bundle must keep this app's
 * identifier, so a mislabelled artifact can never replace Kybern GPUIX.
 */
export async function replaceBundle(bundle: string, archive: Uint8Array, identifier = 'dev.kybern.gpuix') {
  const parent = path.dirname(bundle)
  const staging = await mkdtemp(path.join(parent, '.kybern-update-'))
  try {
    const file = path.join(staging, 'update.app.tar.gz')
    await writeFile(file, archive)
    const unpacked = path.join(staging, 'unpacked')
    await run('/bin/mkdir', [unpacked])
    await run('/usr/bin/tar', ['-xzf', file, '-C', unpacked])
    const apps = (await readdir(unpacked)).filter(name => name.endsWith('.app'))
    if (apps.length !== 1) throw Error('The update archive does not contain one app')
    const next = path.join(unpacked, apps[0]!)
    const { stdout } = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(next, 'Contents/Info.plist')])
    if (stdout.trim() !== identifier) throw Error(`The update is for ${stdout.trim() || 'another app'}, not this one`)
    const backup = path.join(staging, 'previous.app')
    await rename(bundle, backup)
    try { await rename(next, bundle) } catch (error) { await rename(backup, bundle); throw error }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/** ELF `e_machine` of the architectures the feed carries a GPUIX AppImage for. */
const ELF_MACHINE: Record<string, number> = { x64: 62, arm64: 183 }

/**
 * Replace the running AppImage `image` with a verified download. The new file
 * is written beside it (created exclusively, with the old file's mode) and
 * renamed over it, so the mounted old image keeps running until the relaunch.
 * `signedName` is the file name the release signature covers and must be exactly
 * this `version`'s AppImage: Tauri's AppImage and older GPUIX releases are signed
 * with the same key, so a mislabelled feed entry must not replace Kybern GPUIX
 * with them. The bytes must be a type 2 AppImage for this machine's architecture.
 */
export async function replaceAppImage(image: string, data: Uint8Array, signedName: string, version: string, arch: string = process.arch) {
  if (signedName !== appImageName(version, arch)) throw Error(`The update is ${signedName || 'another file'}, not a Kybern GPUIX ${version} AppImage`)
  // A type 2 AppImage is an ELF runtime with the magic bytes `AI\x02` at offset 8. Byte 4 is the class (2 = 64-bit),
  // byte 5 the data encoding (1 = little endian) and bytes 18–19 `e_machine` (62 = x86-64, 183 = AArch64).
  const elf = data[0] === 0x7f && data[1] === 0x45 && data[2] === 0x4c && data[3] === 0x46
  if (!elf || data[8] !== 0x41 || data[9] !== 0x49 || data[10] !== 0x02) throw Error('The update is not an AppImage')
  if (data[4] !== 2 || data[5] !== 1 || data.length < 20 || (data[18]! | (data[19]! << 8)) !== ELF_MACHINE[arch]) throw Error(`The update is not an AppImage for ${arch === 'arm64' ? 'arm64' : 'x86-64'}`)
  const next = path.join(path.dirname(image), `.${path.basename(image)}.update-${process.pid}`)
  let created = false
  try {
    const mode = ((await stat(image)).mode & 0o777) | 0o100
    const handle = await open(next, 'wx', mode)
    created = true
    try { await handle.writeFile(data) } finally { await handle.close() }
    await chmod(next, mode)
    await rename(next, image)
  } catch (error) {
    if (created) await rm(next, { force: true })
    if ((error as NodeJS.ErrnoException).code === 'EACCES' || (error as NodeJS.ErrnoException).code === 'EROFS') throw Error(`Kybern can’t write to ${path.dirname(image)}. Move the AppImage to a folder you own, or download the update from the release page.`)
    throw error
  }
}

async function runUpdateInstall(update: Pending) {
  set({ phase: 'installing', progress: null, error: null, errorKind: null })
  try {
    const install = process.platform === 'linux' ? linuxInstall() : null
    if (install?.kind === 'appimage') {
      const data = await download(update.entry.url, (progress) => set({ progress }))
      const { trustedComment } = verifyMinisign(data, update.entry.signature, feed().pubkey)
      assertSignedRelease(trustedComment, appImageName(update.version), update.version, desktopVersion())
      await replaceAppImage(install.image, data, signedFile(trustedComment) ?? '', update.version)
      return await relaunchAppImage(install.image)
    }
    const windows = process.platform === 'win32'
    const bundle = windows ? windowsInstall() : appBundle()
    if (!bundle) throw Error('Only the packaged app can update itself')
    const archive = await download(update.entry.url, (progress) => set({ progress }))
    const { trustedComment } = verifyMinisign(archive, update.entry.signature, feed().pubkey)
    if (windows) {
      assertWindowsInstaller(trustedComment, update.version, desktopVersion())
      return await runWindowsInstaller(archive, bundle)
    }
    await replaceBundle(bundle, archive)
    await relaunch(bundle)
  } catch (error) {
    set({ phase: 'available', progress: null, error: describe(error), errorKind: 'install' })
    void import('../shell/toasts.tsx').then(({ toast }) => toast.error('Unable to install the update', { description: describe(error) }))
  }
}

/** The `file:` field of a `tauri signer sign` trusted comment (`timestamp:<unix>\tfile:<name>`). */
export const signedFile = (trustedComment: string) => trustedComment.split('\t').find(field => field.startsWith('file:'))?.slice('file:'.length) ?? null

/**
 * The trusted comment is covered by the signature, so it binds the download to a file name. The updater key also
 * signs Tauri's own `-setup.exe` and `.AppImage` and older GPUIX releases, so a swapped feed entry would otherwise
 * install a validly signed build of the wrong app or version. Windows and the Linux AppImage check it; the macOS
 * archive is checked by its bundle identifier instead (`replaceBundle`).
 */
export function assertSignedRelease(trustedComment: string, expected: string, version: string, current: string) {
  if (signedFile(trustedComment) !== expected) throw Error('The update is not the build for this release. Download it from the release page.')
  if (compareVersions(version, current) <= 0) throw Error('The update is not newer than this version. Download it from the release page.')
}
export const assertWindowsInstaller = (trustedComment: string, version: string, current: string) =>
  assertSignedRelease(trustedComment, installerName(version), version, current)

const INSTALLER_DIR_PREFIX = 'kybern-gpuix-update-'

/** Write a verified installer to its own scratch folder; the installer cannot delete itself while it runs. */
export async function stageWindowsInstaller(installer: Uint8Array, parent = tmpdir()): Promise<string> {
  // Every PE file starts with "MZ"; a feed entry that points at something else is refused before it runs.
  if (installer[0] !== 0x4d || installer[1] !== 0x5a) throw Error('The update is not a Windows installer')
  const dir = await mkdtemp(path.join(parent, INSTALLER_DIR_PREFIX))
  const file = path.join(dir, 'kybern-gpuix-setup.exe')
  await writeFile(file, installer)
  return file
}

/** Installers from earlier updates (they cannot remove themselves); best effort. */
export async function removeStaleInstallers(parent = tmpdir(), now = Date.now()) {
  for (const name of await readdir(parent).catch(() => [] as string[])) {
    if (!name.startsWith(INSTALLER_DIR_PREFIX)) continue
    const dir = path.join(parent, name)
    const modified = await stat(dir).then(value => value.mtimeMs, () => now)
    if (now - modified > 60 * 60 * 1000) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * The PowerShell command that starts the installer. NSIS wants `/D=<dir>` last, unquoted, even when the folder
 * has spaces, and reads the program name from a quoted first token; a Node or Bun argument array quotes
 * the argument instead. `Start-Process` takes one argument string and passes it through as written.
 */
export function windowsInstallerCommand(file: string, installDir: string, systemRoot = process.env.SystemRoot ?? 'C:\\Windows') {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
  const dir = /^[A-Za-z]:\\$/.test(installDir) ? installDir : installDir.replace(/\\+$/, '')
  return {
    command: path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `Start-Process -FilePath ${quote(file)} -ArgumentList ${quote(`/S /UPDATE /D=${dir}`)}`],
  }
}

/**
 * Run the installer silently and quit. `/UPDATE` makes it start the new app
 * itself when it finishes (this process is gone by then); the environment is
 * handed over so the same daemon and data folder are used. The other windows
 * are asked to quit first; any that stay (the wait is 10 s) keep running the
 * old files, which the installer moves aside as `.old`, until they are closed.
 */
async function runWindowsInstaller(installer: Uint8Array, installDir: string) {
  const file = await stageWindowsInstaller(installer)
  const stayed = await quitOtherWindows().catch(() => [] as number[])
  if (stayed.length) console.error('[update] other Kybern GPUIX windows are still open:', stayed.join(', '))
  if (process.env.KYBERN_UPDATE_NO_RELAUNCH === '1') { console.error('[update] staged', file); process.exit(0) }
  const { command, args } = windowsInstallerCommand(file, installDir)
  await run(command, args, { windowsHide: true, env: relaunchEnv(process.env) })
  process.exit(0)
}

/**
 * Start the new bundle's executable with this process's environment, then quit
 * (Tauri's `relaunch`, which spawns the binary directly). Keeping the
 * environment keeps the same daemon; its bundled copy restarts once its version
 * no longer matches the app's.
 */
async function relaunch(bundle: string) {
  if (process.env.KYBERN_UPDATE_NO_RELAUNCH === '1') { console.error('[update] installed', bundle); process.exit(0) }
  const { stdout } = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', path.join(bundle, 'Contents/Info.plist')])
  const child = spawn(path.join(bundle, 'Contents/MacOS', stdout.trim()), [], { detached: true, stdio: 'ignore', env: relaunchEnv(process.env) })
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  child.unref()
  process.exit(0)
}

/**
 * Start the replaced AppImage, then quit. It mounts afresh and sets its own
 * APPIMAGE and APPDIR; the rest of the environment is kept, as on macOS, except
 * the daemon and CLI this process resolved, which the new image resolves for itself.
 */
async function relaunchAppImage(image: string) {
  if (process.env.KYBERN_UPDATE_NO_RELAUNCH === '1') { console.error('[update] installed', image); process.exit(0) }
  const env = relaunchEnv(process.env)
  const child = spawn(image, [], { detached: true, stdio: 'ignore', env })
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  child.unref()
  process.exit(0)
}

/** Hide this version's launch announcement across app restarts. */
export function dismissUpdateAnnouncement() {
  if (state.version) storeDismissedUpdateVersion(state.version)
  set({ announcementOpen: false })
}
export function openUpdateDetails() {
  if (!state.version) return
  storeDismissedUpdateVersion(state.version)
  set({ announcementOpen: false, detailsOpen: true })
}
export const closeUpdateDetails = () => set({ detailsOpen: false })

/** Load the app version and, in packaged builds, check shortly after launch and every few hours after that. */
export function startAppUpdateChecks() {
  loadAppVersion()
  // Installers of earlier updates cannot remove themselves.
  if (process.platform === 'win32') void removeStaleInstallers()
  if (!canCheckForUpdates() || timer) return
  const schedule = (delay: number) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { void checkForAppUpdate().finally(() => schedule(CHECK_INTERVAL)) }, delay)
  }
  schedule(Number(process.env.KYBERN_UPDATE_FIRST_CHECK_MS) || FIRST_CHECK_DELAY)
}

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  // The feed is briefly absent while a release is being published, and unreachable offline.
  if (/release JSON|fetch|network|timed out|dns|connect|Unable to connect/i.test(text)) return 'The release feed is unavailable right now. Check your connection or try again in a few minutes.'
  return text
}
const dismissedUpdateVersion = () => readPref<string | null>(DISMISSED_UPDATE_KEY, null) ?? dismissedInSession
function storeDismissedUpdateVersion(version: string) {
  dismissedInSession = version
  try { writePref(DISMISSED_UPDATE_KEY, version) } catch { /* An unavailable store must not block update controls. */ }
}
