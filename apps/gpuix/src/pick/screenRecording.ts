// Whether Kybern may record the screen, and the way to turn it on. `screencapture` (the window capture of a pick) returns the
// desktop without any window until the grant exists, so the window pick first shows the permission card's ask and wait
// phases (`requests/Pick.tsx` `ScreenRecordingStep`).
import { dlopen, FFIType } from 'bun:ffi'
import type { PermissionRequestInput } from '../../../../packages/kybern-client/src/types.ts'

/** True or false from CoreGraphics; null when it cannot be asked (not macOS, or the symbol is missing). */
export function screenRecordingGranted(): boolean | null {
  try {
    const lib = dlopen('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics', { CGPreflightScreenCaptureAccess: { args: [], returns: FFIType.bool } })
    return !!lib.symbols.CGPreflightScreenCaptureAccess()
  } catch { return null }
}

/** The permission card's input for Kybern's own Screen Recording grant (what `kybern_request_permission` would send). */
export const KYBERN_SCREEN_RECORDING: PermissionRequestInput = {
  pane: 'screen_recording',
  app: 'Kybern GPUIX',
  bundle_id: 'dev.kybern.gpuix',
  app_path: null,
  reason: '',
  pane_label: 'Privacy & Security › Screen & System Audio Recording',
  url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  needs_app_added: false,
  relaunch: true,
  detects: true,
}

/** Open System Settings at Screen Recording (the Attach menu of a question, which has no card of its own to wait in). */
export function openScreenRecordingSettings(): void {
  try { Bun.spawn(['open', KYBERN_SCREEN_RECORDING.url], { stdout: 'ignore', stderr: 'ignore' }) } catch { /* System Settings did not open; the error line says what to do. */ }
}
