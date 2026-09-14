// Desktop self-update. The Tauri updater plugin reads `latest.json` from the
// GitHub Release feed configured in tauri.conf.json; this module schedules the
// checks, announces a newer version once, and installs it on request. Every
// call is a no-op in a plain browser and in dev builds, where nothing can be
// replaced. After a relaunch the shell restarts its bundled daemon itself
// because the daemon's version no longer matches the app's.
import type { Update } from "@tauri-apps/plugin-updater"
import { toast } from "sonner"
import { create } from "zustand"

import { reloadOnHotUpdate } from "@/lib/hot"
import { isTauri } from "@/lib/tauri"

export type AppUpdatePhase =
  "idle" | "checking" | "current" | "available" | "installing" | "error"

export interface AppUpdateState {
  phase: AppUpdatePhase
  /** Version of the running app, from the bundle. */
  appVersion: string | null
  /** Version waiting to be installed while `phase` is `available` or `installing`. */
  version: string | null
  notes: string | null
  /** Download progress 0–1 while installing; null until the size is known. */
  progress: number | null
  error: string | null
  errorKind: "check" | "install" | null
  checkedAt: number | null
  announcementOpen: boolean
  detailsOpen: boolean
}

export const useAppUpdate = create<AppUpdateState>(() => ({
  phase: "idle",
  appVersion: null,
  version: null,
  notes: null,
  progress: null,
  error: null,
  errorKind: null,
  checkedAt: null,
  announcementOpen: false,
  detailsOpen: false,
}))

reloadOnHotUpdate(import.meta.hot)

const FIRST_CHECK_DELAY = 15_000
const CHECK_INTERVAL = 6 * 60 * 60 * 1000

let pending: Update | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let checkInFlight: Promise<void> | null = null
let installInFlight: Promise<void> | null = null
let dismissedInSession: string | null = null

const DISMISSED_UPDATE_KEY = "kybern.update.dismissed-version"

/** True when this build can replace itself: packaged, inside the Tauri shell. */
export const canSelfUpdate = (): boolean => isTauri() && !import.meta.env?.DEV

export async function loadAppVersion(): Promise<void> {
  if (!isTauri()) return
  try {
    const { getVersion } = await import("@tauri-apps/api/app")
    useAppUpdate.setState({ appVersion: await getVersion() })
  } catch {
    /* the About panel shows an ellipsis instead */
  }
}

/** Ask the release feed for a newer version. */
export function checkForAppUpdate(
  options: { manual?: boolean } = {}
): Promise<void> {
  if (!canSelfUpdate()) return Promise.resolve()
  if (installInFlight) return installInFlight
  if (checkInFlight) return checkInFlight

  checkInFlight = runUpdateCheck(options).finally(() => {
    checkInFlight = null
  })
  return checkInFlight
}

async function runUpdateCheck(options: { manual?: boolean }): Promise<void> {
  const { phase } = useAppUpdate.getState()
  if (phase === "installing") return
  useAppUpdate.setState({ phase: "checking", error: null, errorKind: null })
  try {
    const { check } = await import("@tauri-apps/plugin-updater")
    const update = await check({ timeout: 30_000 })
    const previous = pending
    pending = update
    if (!update) {
      if (previous) await previous.close().catch(() => {})
      useAppUpdate.setState({
        phase: "current",
        version: null,
        notes: null,
        checkedAt: Date.now(),
        announcementOpen: false,
        detailsOpen: false,
      })
      return
    }
    if (previous && previous !== update) await previous.close().catch(() => {})
    useAppUpdate.setState({
      phase: "available",
      version: update.version,
      notes: update.body ?? null,
      checkedAt: Date.now(),
      announcementOpen: dismissedUpdateVersion() !== update.version,
    })
  } catch (error) {
    const message = describe(error)
    useAppUpdate.setState({
      phase: pending ? "available" : "error",
      error: message,
      errorKind: "check",
      checkedAt: Date.now(),
    })
    if (options.manual)
      toast.error("Unable to check for updates", { description: message })
  }
}

/** Download, verify and install the pending update, then relaunch. */
export function installAppUpdate(): Promise<void> {
  if (installInFlight) return installInFlight
  if (useAppUpdate.getState().phase === "installing") return Promise.resolve()
  if (checkInFlight) return checkInFlight.then(() => installAppUpdate())

  const update = pending
  if (!update) return Promise.resolve()
  installInFlight = runUpdateInstall(update).finally(() => {
    installInFlight = null
  })
  return installInFlight
}

async function runUpdateInstall(update: Update): Promise<void> {
  useAppUpdate.setState({
    phase: "installing",
    progress: null,
    error: null,
    errorKind: null,
  })
  let downloaded = 0
  let total: number | null = null
  try {
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        downloaded = 0
        total =
          typeof event.data.contentLength === "number" &&
          Number.isFinite(event.data.contentLength) &&
          event.data.contentLength > 0
            ? event.data.contentLength
            : null
        useAppUpdate.setState({ progress: total === null ? null : 0 })
      } else if (event.event === "Progress") {
        const chunk = event.data.chunkLength
        if (Number.isFinite(chunk)) downloaded += Math.max(0, chunk)
        if (total !== null)
          useAppUpdate.setState({
            progress: Math.max(0, Math.min(1, downloaded / total)),
          })
      } else if (event.event === "Finished")
        useAppUpdate.setState({ progress: 1 })
    })
    const { relaunch } = await import("@tauri-apps/plugin-process")
    await relaunch()
  } catch (error) {
    useAppUpdate.setState({
      phase: "available",
      progress: null,
      error: describe(error),
      errorKind: "install",
    })
    toast.error("Unable to install the update", {
      description: describe(error),
    })
  }
}

/** Hide this version's launch announcement across app reloads. */
export function dismissUpdateAnnouncement(): void {
  const { version } = useAppUpdate.getState()
  if (version) storeDismissedUpdateVersion(version)
  useAppUpdate.setState({ announcementOpen: false })
}

/** Show release details whenever an update is still known to the store. */
export function openUpdateDetails(): void {
  const { version } = useAppUpdate.getState()
  if (!version) return
  storeDismissedUpdateVersion(version)
  useAppUpdate.setState({ announcementOpen: false, detailsOpen: true })
}

export function closeUpdateDetails(): void {
  useAppUpdate.setState({ detailsOpen: false })
}

/** Load the app version and, in packaged builds, check shortly after launch and every few hours after that. */
export function startAppUpdateChecks(): void {
  void loadAppVersion()
  if (!canSelfUpdate()) return
  const schedule = (delay: number) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      void checkForAppUpdate().finally(() => schedule(CHECK_INTERVAL))
    }, delay)
  }
  schedule(FIRST_CHECK_DELAY)
}

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  // The feed is briefly absent while a release is being published, and
  // unreachable offline; neither is worth the plugin's raw wording.
  if (/release JSON|fetch|network|timed out|dns|connect/i.test(text)) {
    return "The release feed is unavailable right now. Check your connection or try again in a few minutes."
  }
  return text
}

function dismissedUpdateVersion(): string | null {
  try {
    return (
      globalThis.localStorage?.getItem(DISMISSED_UPDATE_KEY) ??
      dismissedInSession
    )
  } catch {
    return dismissedInSession
  }
}

function storeDismissedUpdateVersion(version: string): void {
  dismissedInSession = version
  try {
    globalThis.localStorage?.setItem(DISMISSED_UPDATE_KEY, version)
  } catch {
    /* An unavailable app-local store should not block update controls. */
  }
}
