// Compact an occluded or minimized environment window's transcript, then restore
// it with the saved reading position. Blur/focus are tracked but never compact.

import { reloadOnHotUpdate } from "@/lib/hot"
import { isTauri } from "@/lib/tauri"
import { useStore } from "./store"
import {
  captureTranscriptAnchors,
  isWindowOnScreen,
  patchWindowSurface,
  resetWindowSurfaceForTests,
  setTranscriptReleased,
  windowFocusAnchor,
  windowHoldsTranscript,
  type WindowSurface,
} from "./windowSurfaceState"

export {
  consumeTranscriptAnchor,
  isWindowOnScreen,
  peekTranscriptAnchor,
  registerTranscriptAnchor,
  windowFocusAnchor,
  windowHoldsTranscript,
  windowSurface,
  type TranscriptAnchor,
  type WindowFocusAnchor,
  type WindowSurface,
} from "./windowSurfaceState"

/** Brief occlusion (Mission Control, dragging a window across) must not flash a loader. */
export const HIDDEN_WINDOW_COMPACT_DELAY_MS = 400

let compactTimer: ReturnType<typeof setTimeout> | undefined
let installed = false

export function applyWindowSurface(patch: Partial<WindowSurface>): void {
  patchWindowSurface(patch)
  syncHiddenTranscript()
}

function syncHiddenTranscript(): void {
  if (isWindowOnScreen()) {
    if (compactTimer !== undefined) {
      clearTimeout(compactTimer)
      compactTimer = undefined
    }
    if (!windowHoldsTranscript()) restoreHiddenTranscript()
    return
  }
  if (!windowHoldsTranscript() || compactTimer !== undefined) return
  compactTimer = setTimeout(() => {
    compactTimer = undefined
    if (!isWindowOnScreen() && windowHoldsTranscript()) compactHiddenTranscript()
  }, HIDDEN_WINDOW_COMPACT_DELAY_MS)
}

/** Tests skip the delay so occluded vs blur can be asserted in one turn. */
export function flushHiddenWindowCompact(): void {
  if (compactTimer !== undefined) {
    clearTimeout(compactTimer)
    compactTimer = undefined
  }
  if (!isWindowOnScreen() && windowHoldsTranscript()) compactHiddenTranscript()
}

function compactHiddenTranscript(): void {
  captureTranscriptAnchors()
  setTranscriptReleased(true)
  useStore.getState().releaseCachedData()
  void Promise.all([
    import("@/lib/highlight").then((module) => module.releaseHighlightCaches()),
    import("@/lib/markdown").then((module) => module.releaseMarkdownCaches()),
    import("@/lib/mermaid").then((module) => module.releaseMermaidCaches()),
  ]).catch(() => { /* Workers and diagram frames are browser-only. */ })
}

function restoreHiddenTranscript(): void {
  setTranscriptReleased(false)
  void import("./rpc").then(({ loadOpenThreads }) => {
    loadOpenThreads()
    restoreFocus()
  })
}

function restoreFocus(): void {
  if (typeof document === "undefined" || document.hidden) return
  const kind = windowFocusAnchor()
  requestAnimationFrame(() => {
    if (kind === "composer") {
      document.querySelector<HTMLElement>("[data-testid=composer-editor]")?.focus({ preventScroll: true })
    } else if (kind === "transcript") {
      document.querySelector<HTMLElement>("[data-chat-scroll-container]")?.focus({ preventScroll: true })
    }
  })
}

function onPageVisibility(): void {
  // Page Visibility on macOS WebKit is occlusion/miniaturize, not key-window focus.
  syncHiddenTranscript()
}

export async function installWindowSurface(): Promise<void> {
  if (installed || typeof window === "undefined") return
  installed = true
  document.addEventListener("visibilitychange", onPageVisibility)
  window.addEventListener("focus", () => applyWindowSurface({ focused: true }))
  window.addEventListener("blur", () => applyWindowSurface({ focused: false }))
  applyWindowSurface({
    focused: document.hasFocus(),
  })
  if (!isTauri()) return
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    const { getCurrentWindow } = await import("@tauri-apps/api/window")
    const native = await invoke<WindowSurface>("window_surface")
    applyWindowSurface(native)
    await getCurrentWindow().listen<WindowSurface>("kybern-window-surface", (event) => {
      applyWindowSurface(event.payload)
    })
  } catch {
    /* Browser tests and older shells still compact from Page Visibility. */
  }
}

export function resetHiddenWindowCompact(): void {
  if (compactTimer !== undefined) {
    clearTimeout(compactTimer)
    compactTimer = undefined
  }
  resetWindowSurfaceForTests()
}

reloadOnHotUpdate(import.meta.hot)
