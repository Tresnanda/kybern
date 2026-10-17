// App self-update, the desktop's `lib/appUpdate.ts` flow on GPUIX: the same
// release feed and public key as the Tauri updater (`tauri.conf.json`
// `plugins.updater`), checked 15 s after launch and every 6 h, announced once
// per version, installed on request with download progress, then relaunched.
// The packaged daemon is restarted by the shell on the next launch because its
// version no longer matches (`shell/daemon.ts`).
//
// What Tauri's updater does natively is done here: fetch `latest.json`, pick
// this build's platform entry, download it, verify the minisign signature
// (`minisign.ts`), unpack the `.app.tar.gz` and swap the bundle in place.
// GPUIX ships as its own bundle (`dev.kybern.gpuix`), so its feed entry is
// `darwin-aarch64-gpuix` (Tauri's `{target}-{bundle}` key form); the desktop's
// `darwin-aarch64` artifact is a different app and is never installed here.
//
// Tests point the app at a local feed with KYBERN_UPDATE_FEED (loopback only)
// and KYBERN_UPDATE_PUBKEY; nothing else can change the key.
import { spawn, execFile } from 'node:child_process'
import { mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { useSyncExternalStore } from 'react'
import conf from '../../../desktop/src-tauri/tauri.conf.json'
import { desktopVersion } from '../shell/daemon.ts'
import { compareVersions } from '../shell/platform.ts'
import { readPref, writePref } from './prefs.ts'
import { verifyMinisign } from './minisign.ts'

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
}

let state: AppUpdateState = { phase: 'idle', appVersion: null, version: null, notes: null, progress: null, error: null, errorKind: null, checkedAt: null, announcementOpen: false, detailsOpen: false, unpublished: null }
const listeners = new Set<() => void>()
const set = (patch: Partial<AppUpdateState>) => { state = { ...state, ...patch }; for (const l of listeners) l() }
export const getAppUpdate = () => state
export function useAppUpdate<T>(select: (s: AppUpdateState) => T): T {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, () => select(state))
}

const FIRST_CHECK_DELAY = 15_000
const CHECK_INTERVAL = 6 * 60 * 60 * 1000
const DISMISSED_UPDATE_KEY = 'kybern.update.dismissed-version'
export const PLATFORM_KEY = `darwin-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-gpuix`

interface FeedEntry { url: string; signature: string }
interface Pending { version: string; notes: string | null; entry: FeedEntry }
let pending: Pending | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let checkInFlight: Promise<void> | null = null
let installInFlight: Promise<void> | null = null
let dismissedInSession: string | null = null

/** The `.app` this process runs from, or null outside a packaged build. */
export function appBundle(execPath = process.execPath): string | null {
  const match = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)
  return match ? match[1]! : null
}

function feed(): { endpoints: string[]; pubkey: string } {
  const override = process.env.KYBERN_UPDATE_FEED
  if (override) {
    const url = new URL(override)
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('KYBERN_UPDATE_FEED must be a loopback http address')
    return { endpoints: [override], pubkey: process.env.KYBERN_UPDATE_PUBKEY ?? conf.plugins.updater.pubkey }
  }
  return { endpoints: conf.plugins.updater.endpoints, pubkey: conf.plugins.updater.pubkey }
}

/** True when this build can replace itself: a packaged, writable `.app`. */
export const canSelfUpdate = (): boolean => process.platform === 'darwin' && !!appBundle() && process.env.KYBERN_DISABLE_UPDATES !== '1'

export function loadAppVersion() {
  try { set({ appVersion: desktopVersion() }) } catch { /* About shows an ellipsis instead. */ }
}

/** Ask the release feed for a newer version. */
export function checkForAppUpdate(options: { manual?: boolean } = {}): Promise<void> {
  if (!canSelfUpdate()) return Promise.resolve()
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
      set({ phase: 'current', version: null, notes: null, checkedAt: Date.now(), announcementOpen: false, detailsOpen: false, unpublished: result?.version ?? null })
      return
    }
    pending = { version: result.version, notes: result.notes, entry: result.entry }
    set({ phase: 'available', version: result.version, notes: result.notes, checkedAt: Date.now(), unpublished: null, announcementOpen: dismissedUpdateVersion() !== result.version })
  } catch (error) {
    set({ phase: pending ? 'available' : 'error', error: describe(error), errorKind: 'check', checkedAt: Date.now() })
    if (options.manual) void import('../shell/toasts.tsx').then(({ toast }) => toast.error('Unable to check for updates', { description: describe(error) }))
  }
}

/** Download, verify and install the pending update, then relaunch. */
export function installAppUpdate(): Promise<void> {
  if (installInFlight) return installInFlight
  if (state.phase === 'installing') return Promise.resolve()
  if (checkInFlight) return checkInFlight.then(() => installAppUpdate())
  const update = pending
  if (!update) return Promise.resolve()
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

async function runUpdateInstall(update: Pending) {
  set({ phase: 'installing', progress: null, error: null, errorKind: null })
  try {
    const bundle = appBundle()
    if (!bundle) throw Error('Only the packaged app can update itself')
    const archive = await download(update.entry.url, (progress) => set({ progress }))
    verifyMinisign(archive, update.entry.signature, feed().pubkey)
    await replaceBundle(bundle, archive)
    relaunch(bundle)
  } catch (error) {
    set({ phase: 'available', progress: null, error: describe(error), errorKind: 'install' })
    void import('../shell/toasts.tsx').then(({ toast }) => toast.error('Unable to install the update', { description: describe(error) }))
  }
}

/** Start the new bundle, then quit (Tauri's `relaunch`). The bundled daemon restarts when its version no longer matches. */
function relaunch(bundle: string) {
  if (process.env.KYBERN_UPDATE_NO_RELAUNCH === '1') { console.error('[update] installed', bundle); process.exit(0) }
  const child = spawn('/usr/bin/open', ['-n', bundle], { detached: true, stdio: 'ignore', env: process.env })
  child.unref()
  child.once('spawn', () => setTimeout(() => process.exit(0), 100))
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
  if (!canSelfUpdate() || timer) return
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
