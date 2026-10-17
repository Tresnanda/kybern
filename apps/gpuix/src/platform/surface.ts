// Compact an occluded or minimized window's transcript, then restore it with the
// saved reading position: the desktop's `state/windowSurface.ts` (issue #33,
// constraint #37). Blur is never compact permission; an unfocused window that is
// still on screen keeps everything mounted.
//
// Hidden for 400 ms (a brief occlusion such as Mission Control must not flash a
// loader) → the transcript lists unmount (each saves its scroll anchor, as on a
// thread switch) and every open thread drops its blocks and live subscription
// (`releaseOpenTranscripts`). The composer, its drafts and attachments, queued
// prompts, pending approvals and questions, terminals and the dock stay mounted.
// Shown again → the threads rehydrate (`reloadOpenTranscripts`) and each list
// restores its anchor (follow or the saved row and offset).
//
// The signal is AppKit's occlusion state plus miniaturization
// (`native/visibility.ts`). Automation windows (`GPUIX_BACKGROUND=1`) usually sit
// behind other apps, so they opt in with `KYBERN_HIDDEN_COMPACT=1`; screenshots
// of covered windows would otherwise capture the placeholder.
import { useSyncExternalStore } from 'react'
import { isWindowVisible, onWindowVisibility } from '../native/visibility.ts'
import { reloadOpenTranscripts, releaseOpenTranscripts } from '../state.ts'

export const HIDDEN_WINDOW_COMPACT_DELAY_MS = 400

let released = false
let timer: ReturnType<typeof setTimeout> | undefined
let stop: (() => void) | undefined
const listeners = new Set<() => void>()
const emit = () => { for (const l of listeners) l() }
const log = (message: string) => { if (process.env.KYBERN_DEBUG_COMPACT) console.log(`[compact] ${message} ${Date.now()}`) }

export const isTranscriptReleased = () => released
/** True while a hidden window has released its transcripts; the page shows a placeholder instead. */
export const useTranscriptReleased = () => useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, isTranscriptReleased)

function compact() {
  if (released) return
  released = true
  log('released')
  // Unmount first: each list saves its anchor while its rows still exist.
  emit()
  queueMicrotask(releaseOpenTranscripts)
}
function restore() {
  if (!released) return
  released = false
  log('restored')
  reloadOpenTranscripts()
  emit()
}
function sync(visible: boolean) {
  if (visible) {
    clearTimeout(timer); timer = undefined
    restore()
    return
  }
  if (released || timer) return
  timer = setTimeout(() => { timer = undefined; if (!isWindowVisible()) compact() }, HIDDEN_WINDOW_COMPACT_DELAY_MS)
}

export const hiddenCompactEnabled = () => process.env.KYBERN_HIDDEN_COMPACT === '1' || (process.env.GPUIX_BACKGROUND !== '1' && process.env.KYBERN_HIDDEN_COMPACT !== '0')

/** Start following the window's surface. Called once by the app shell. */
export function installWindowSurface() {
  if (stop || !hiddenCompactEnabled()) return
  stop = onWindowVisibility(sync)
  sync(isWindowVisible())
}
