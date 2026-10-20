// Kybern GPUIX, the native macOS app that ships beside this one. After an
// update to 0.10.0 the app offers it once; the install itself (download,
// signature check, swap into /Applications) is the `install_gpuix` command in
// the Tauri shell. This module is the launch check, the one-time record and
// the install state shared by the card and the Settings row.
import { create } from "zustand"

import { reloadOnHotUpdate } from "@/lib/hot"
import {
  eligibleAtLaunch,
  type GpuixPromptRecord,
  type GpuixStep,
} from "@/lib/gpuixPromptRules"
import { isTauri } from "@/lib/tauri"

export type GpuixPhase = "idle" | "installing" | "done" | "error"

export interface GpuixState {
  /** This Mac can run GPUIX; unknown (false) until the shell answers. */
  supported: boolean
  installed: boolean
  /** Decided at launch: should the one-time card ever appear? */
  eligible: boolean
  /** The card was closed or finished this session. */
  dismissed: boolean
  phase: GpuixPhase
  step: GpuixStep | null
  /** Download progress 0–1 while `step` is downloading; null when unknown. */
  progress: number | null
  error: string | null
}

export const useGpuix = create<GpuixState>(() => ({
  supported: false,
  installed: false,
  eligible: false,
  dismissed: false,
  phase: "idle",
  step: null,
  progress: null,
  error: null,
}))

export type { GpuixStep }
export { GPUIX_MANUAL_COMMAND, gpuixErrorParts, gpuixStepLabel } from "@/lib/gpuixPromptRules"

reloadOnHotUpdate(import.meta.hot)

const RECORD_KEY = "kybern.gpuix.prompt"
const DONE_VISIBLE_MS = 2200

let recordInSession: GpuixPromptRecord = null

export function readGpuixRecord(): GpuixPromptRecord {
  try {
    const value = globalThis.localStorage?.getItem(RECORD_KEY)
    if (value === "shown" || value === "dismissed") return value
  } catch {
    /* fall through to the in-session record */
  }
  return recordInSession
}

function writeGpuixRecord(value: Exclude<GpuixPromptRecord, null>): void {
  // "shown" never downgrades a "dismissed" record.
  if (value === "shown" && readGpuixRecord() !== null) return
  recordInSession = value
  try {
    globalThis.localStorage?.setItem(RECORD_KEY, value)
  } catch {
    /* An unavailable store only means the card may return next launch. */
  }
}

/** Called when the card first becomes visible: it is shown once, ever. */
export function markGpuixPromptShown(): void {
  writeGpuixRecord("shown")
}

async function invokeShell<T>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core")
  return invoke<T>(command, args)
}

/** Refresh whether GPUIX is installed (Settings calls this when it opens). */
export async function refreshGpuixStatus(): Promise<void> {
  if (!isTauri()) return
  try {
    const status = await invokeShell<{ supported: boolean; installed: boolean }>(
      "gpuix_status"
    )
    useGpuix.setState({
      supported: status.supported,
      installed: status.installed,
    })
  } catch {
    /* the row stays hidden */
  }
}

/** Launch check: decide once whether this person gets the invitation. */
export async function startGpuixPrompt(): Promise<void> {
  if (!isTauri()) return
  try {
    await refreshGpuixStatus()
    const { getVersion } = await import("@tauri-apps/api/app")
    const { supported, installed } = useGpuix.getState()
    useGpuix.setState({
      eligible: eligibleAtLaunch({
        version: await getVersion(),
        inShell: true,
        supported,
        installed,
        record: readGpuixRecord(),
      }),
    })
  } catch {
    /* no invitation if the shell cannot answer */
  }
}

/** "Not now": the card never returns. */
export function dismissGpuixPrompt(): void {
  writeGpuixRecord("dismissed")
  useGpuix.setState({ dismissed: true })
}

let installInFlight: Promise<void> | null = null

/** Download, verify and install GPUIX, then let the shell open it. */
export function installGpuix(): Promise<void> {
  if (installInFlight) return installInFlight
  installInFlight = runInstall().finally(() => {
    installInFlight = null
  })
  return installInFlight
}

async function runInstall(): Promise<void> {
  useGpuix.setState({
    phase: "installing",
    step: "downloading",
    progress: null,
    error: null,
  })
  let off: (() => void) | null = null
  try {
    const { listen } = await import("@tauri-apps/api/event")
    off = await listen<{ phase: string; progress: number | null }>(
      "gpuix-install-progress",
      ({ payload }) => {
        if (payload.phase === "done") return
        if (
          payload.phase === "downloading" ||
          payload.phase === "verifying" ||
          payload.phase === "installing"
        )
          useGpuix.setState({
            step: payload.phase,
            progress: payload.phase === "downloading" ? payload.progress : null,
          })
      }
    )
    await invokeShell("install_gpuix")
    useGpuix.setState({
      phase: "done",
      step: null,
      progress: null,
      installed: true,
    })
    writeGpuixRecord("dismissed")
    setTimeout(
      () => useGpuix.setState({ dismissed: true }),
      DONE_VISIBLE_MS
    )
  } catch (error) {
    useGpuix.setState({
      phase: "error",
      step: null,
      progress: null,
      error: typeof error === "string" ? error : error instanceof Error ? error.message : String(error),
    })
  } finally {
    off?.()
  }
}

/** Open the installed GPUIX. */
export async function openGpuix(): Promise<void> {
  await invokeShell("open_gpuix")
}
