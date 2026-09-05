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

export type AppUpdatePhase = "idle" | "checking" | "current" | "available" | "installing" | "error"

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
  checkedAt: number | null
}

export const useAppUpdate = create<AppUpdateState>(() => ({
  phase: "idle",
  appVersion: null,
  version: null,
  notes: null,
  progress: null,
  error: null,
  checkedAt: null,
}))

reloadOnHotUpdate(import.meta.hot)

const FIRST_CHECK_DELAY = 15_000
const CHECK_INTERVAL = 6 * 60 * 60 * 1000

let pending: Update | null = null
let announced: string | null = null
let timer: ReturnType<typeof setTimeout> | null = null

/** True when this build can replace itself: packaged, inside the Tauri shell. */
export const canSelfUpdate = (): boolean => isTauri() && !import.meta.env.DEV

export async function loadAppVersion(): Promise<void> {
  if (!isTauri()) return
  try {
    const { getVersion } = await import("@tauri-apps/api/app")
    useAppUpdate.setState({ appVersion: await getVersion() })
  } catch {
    /* the About panel shows an ellipsis instead */
  }
}

/** Ask the release feed for a newer version. Automatic checks announce a find once with a toast; manual checks leave that to the settings row. */
export async function checkForAppUpdate(options: { manual?: boolean } = {}): Promise<void> {
  if (!canSelfUpdate()) return
  const { phase } = useAppUpdate.getState()
  if (phase === "checking" || phase === "installing") return
  useAppUpdate.setState({ phase: "checking", error: null })
  try {
    const { check } = await import("@tauri-apps/plugin-updater")
    const update = await check({ timeout: 30_000 })
    if (pending && pending !== update) await pending.close().catch(() => {})
    pending = update
    if (!update) {
      useAppUpdate.setState({ phase: "current", version: null, notes: null, checkedAt: Date.now() })
      return
    }
    useAppUpdate.setState({ phase: "available", version: update.version, notes: update.body ?? null, checkedAt: Date.now() })
    if (!options.manual && announced !== update.version) {
      announced = update.version
      toast(`Kybern ${update.version} is available`, {
        description: "Installing restarts the app and the agents running on this machine.",
        action: { label: "Update and restart", onClick: () => void installAppUpdate() },
        duration: 20_000,
      })
    }
  } catch (error) {
    useAppUpdate.setState({ phase: "error", error: describe(error), checkedAt: Date.now() })
    if (options.manual) toast.error("Unable to check for updates", { description: describe(error) })
  }
}

/** Download, verify and install the pending update, then relaunch. */
export async function installAppUpdate(): Promise<void> {
  const update = pending
  if (!update || useAppUpdate.getState().phase === "installing") return
  useAppUpdate.setState({ phase: "installing", progress: null, error: null })
  let downloaded = 0
  let total: number | null = null
  try {
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") total = event.data.contentLength ?? null
      else if (event.event === "Progress") {
        downloaded += event.data.chunkLength
        if (total) useAppUpdate.setState({ progress: Math.min(1, downloaded / total) })
      } else if (event.event === "Finished") useAppUpdate.setState({ progress: 1 })
    })
    const { relaunch } = await import("@tauri-apps/plugin-process")
    await relaunch()
  } catch (error) {
    useAppUpdate.setState({ phase: "available", progress: null, error: describe(error) })
    toast.error("Unable to install the update", { description: describe(error) })
  }
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
