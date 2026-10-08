// Which device the toolbar opens with: the last preset chosen in this environment.

import { VIEWPORT_PRESETS, viewportPreset } from "../../../../../../packages/kybern-client/src/previewViewport"
import type { PreviewViewport } from "@/state/store"

const KEY = "kybern.preview.device"
const FALLBACK = "iphone-12-pro"

function readAll(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}")
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

export function rememberDevicePreset(environment: string, presetId: string | null): void {
  if (!presetId || !VIEWPORT_PRESETS.some((preset) => preset.id === presetId)) return
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readAll(), [environment]: presetId }))
  } catch { /* a per-viewer convenience */ }
}

export function startingDeviceViewport(environment: string): Extract<PreviewViewport, { mode: "device" }> {
  const preset = viewportPreset(readAll()[environment] ?? "") ?? viewportPreset(FALLBACK)!
  return { mode: "device", presetId: preset.id, width: preset.w, height: preset.h }
}
