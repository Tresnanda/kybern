// When the one-time Kybern GPUIX invitation appears. Pure, so the decision can
// be tested without the Tauri shell: `lib/gpuix.ts` gathers the inputs.

/** First desktop version that carries the invitation. */
export const GPUIX_PROMPT_MIN_VERSION = "0.10.0"

/** What the app remembers: shown once, or declined with "Not now". */
export type GpuixPromptRecord = "shown" | "dismissed" | null

/** True when `version` is `minimum` or newer; pre-release suffixes are ignored. */
export function versionAtLeast(version: string, minimum: string): boolean {
  const parts = (value: string) =>
    value
      .replace(/^v/, "")
      .split(/[-+]/)[0]!
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0)
  const a = parts(version)
  const b = parts(minimum)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference > 0
  }
  return true
}

export interface GpuixLaunchFacts {
  /** Running desktop version, or null when it could not be read. */
  version: string | null
  /** Inside the Tauri shell (never in a browser tab or in GPUIX itself). */
  inShell: boolean
  /** macOS on Apple Silicon or Intel. */
  supported: boolean
  installed: boolean
  record: GpuixPromptRecord
}

/** Decided once per launch: does this person get the invitation at all? */
export function eligibleAtLaunch(facts: GpuixLaunchFacts): boolean {
  return (
    facts.inShell &&
    facts.supported &&
    !facts.installed &&
    facts.record === null &&
    facts.version !== null &&
    versionAtLeast(facts.version, GPUIX_PROMPT_MIN_VERSION)
  )
}

export interface GpuixShowFacts {
  eligible: boolean
  /** The person closed the card (or it finished) during this session. */
  dismissed: boolean
  /** The first update check is done, so we know whether an announcement is coming. */
  updateSettled: boolean
  /** The update announcement card or its release details are open. */
  updateOpen: boolean
}

/** Whether the card is on screen right now; it waits behind the update announcement. */
export function shouldShowGpuixPrompt(facts: GpuixShowFacts): boolean {
  return facts.eligible && !facts.dismissed && facts.updateSettled && !facts.updateOpen
}

export type GpuixStep = "downloading" | "verifying" | "installing"

export const GPUIX_MANUAL_COMMAND =
  "curl -fsSL https://github.com/Tresnanda/kybern/releases/latest/download/kybern-gpuix-mac-install.sh | sh"
// The shell appends this to every install error (`gpuix_install.rs`).
const MANUAL_HINT = " To install it yourself, run this in Terminal: "

/** Split a shell error into its message and the manual command it suggests. */
export function gpuixErrorParts(error: string): {
  message: string
  command: string
} {
  const at = error.indexOf(MANUAL_HINT)
  if (at < 0) return { message: error, command: GPUIX_MANUAL_COMMAND }
  return {
    message: error.slice(0, at).trim(),
    command: error.slice(at + MANUAL_HINT.length).trim() || GPUIX_MANUAL_COMMAND,
  }
}

/** Progress text for the install button. */
export function gpuixStepLabel(step: GpuixStep | null, progress: number | null): string {
  if (step === "verifying") return "Verifying…"
  if (step === "installing") return "Installing…"
  return progress === null ? "Downloading…" : `Downloading… ${Math.round(progress * 100)}%`
}
