// Whether Kybern may record the screen, and the way to turn it on. `screencapture` (the window capture of a pick) returns the
// desktop without any window until the grant exists. The permission card (macOS permission requests, Camera to Screen
// Recording) replaces `ensureScreenRecording` when it lands; this is the small interface the pick card calls until then.
import { dlopen, FFIType } from 'bun:ffi'
import { spawn } from 'node:child_process'

/** True or false from CoreGraphics; null when it cannot be asked (not macOS, or the symbol is missing). */
export function screenRecordingGranted(): boolean | null {
  try {
    const lib = dlopen('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics', { CGPreflightScreenCaptureAccess: { args: [], returns: FFIType.bool } })
    return !!lib.symbols.CGPreflightScreenCaptureAccess()
  } catch { return null }
}

export function openScreenRecordingSettings() {
  spawn('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'], { stdio: 'ignore', detached: true }).unref()
}

/** Resolves true when capture can proceed. Unknown (null) proceeds: the capture itself shows what is wrong. */
export async function ensureScreenRecording(): Promise<boolean> {
  return screenRecordingGranted() !== false
}
