/** Physical window surface plus whether this renderer still holds transcript DOM.
 * Occlusion and miniaturize are independent of key-window focus: an unfocused
 * window can still be on screen, and must not drop reconstructible state. */

export interface WindowSurface {
  occluded: boolean
  minimized: boolean
  focused: boolean
}

export interface TranscriptAnchor {
  following: boolean
  messageId?: string
  turnId?: string
  seq?: number
}

export type WindowFocusAnchor = "composer" | "transcript" | "terminal" | "other"

const DEFAULT_SURFACE: WindowSurface = { occluded: false, minimized: false, focused: true }

let surface: WindowSurface = { ...DEFAULT_SURFACE }
let transcriptReleased = false
let focusAnchor: WindowFocusAnchor = "other"
const anchors = new Map<string, TranscriptAnchor>()
const capturers = new Map<string, () => TranscriptAnchor>()
const listeners = new Set<() => void>()

function pageHidden(): boolean {
  return typeof document !== "undefined" && document.hidden
}

export function windowSurface(): WindowSurface {
  return surface
}

/** True when the window is occluded, minimized, or page-hidden — not when merely unfocused. */
export function isWindowOnScreen(): boolean {
  return !surface.occluded && !surface.minimized && !pageHidden()
}

/** After a hidden-window compact, open threads are treated as inactive until restore. */
export function windowHoldsTranscript(): boolean {
  return !transcriptReleased
}

export function setTranscriptReleased(released: boolean): void {
  if (transcriptReleased === released) return
  transcriptReleased = released
  notify()
}

export function patchWindowSurface(patch: Partial<WindowSurface>): boolean {
  const next: WindowSurface = {
    occluded: patch.occluded ?? surface.occluded,
    minimized: patch.minimized ?? surface.minimized,
    focused: patch.focused ?? surface.focused,
  }
  if (next.occluded === surface.occluded && next.minimized === surface.minimized && next.focused === surface.focused) {
    return false
  }
  surface = next
  notify()
  return true
}

export function subscribeWindowSurface(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function notify(): void {
  for (const listener of listeners) listener()
}

export function registerTranscriptAnchor(threadId: string, capture: () => TranscriptAnchor): () => void {
  capturers.set(threadId, capture)
  return () => { if (capturers.get(threadId) === capture) capturers.delete(threadId) }
}

export function captureTranscriptAnchors(): void {
  anchors.clear()
  for (const [threadId, capture] of capturers) {
    try { anchors.set(threadId, capture()) } catch { /* Unmounting views can race capture. */ }
  }
  focusAnchor = captureFocusAnchor()
}

export function peekTranscriptAnchor(threadId: string): TranscriptAnchor | undefined {
  return anchors.get(threadId)
}

export function consumeTranscriptAnchor(threadId: string): TranscriptAnchor | undefined {
  const saved = anchors.get(threadId)
  if (saved) anchors.delete(threadId)
  return saved
}

export function windowFocusAnchor(): WindowFocusAnchor {
  return focusAnchor
}

export function setWindowFocusAnchor(next: WindowFocusAnchor): void {
  focusAnchor = next
}

function captureFocusAnchor(): WindowFocusAnchor {
  if (typeof document === "undefined" || typeof HTMLElement === "undefined") return "other"
  const active = document.activeElement
  if (!(active instanceof HTMLElement)) return "other"
  if (active.closest("[data-testid=composer-editor], .thread-composer")) return "composer"
  if (active.closest("[data-chat-transcript-pane]")) return "transcript"
  if (active.closest(".xterm, [data-workspace-dock]")) return "terminal"
  return "other"
}

export function resetWindowSurfaceForTests(): void {
  surface = { ...DEFAULT_SURFACE }
  transcriptReleased = false
  focusAnchor = "other"
  anchors.clear()
  capturers.clear()
  notify()
}
