// What the new chat screen keeps outside React: the task attached from Up next (per pane, one at a time), and the one-shot
// launch record a send leaves for the thread page it opens (`Morph.tsx`), like `ImageMorph`'s source rect.
import type { PaintTransformProps } from '@gpuix/native/host'
import { useSyncExternalStore, type ReactNode } from 'react'
import type { LayoutRect } from '../native/layout.ts'
import { toggleAttached } from './model.ts'

const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

// ---- the attached task ----

const attached = new Map<string, string>()
export const attachedTaskId = (paneId: string) => attached.get(paneId) ?? null
export function useAttachedTaskId(paneId: string): string | null {
  return useSyncExternalStore(subscribe, () => attached.get(paneId) ?? null)
}
/** Up next's click: attach, detach the same task, or replace another. */
export function toggleAttachedTask(paneId: string, id: string) {
  const next = toggleAttached(attached.get(paneId) ?? null, id)
  if (next) attached.set(paneId, next)
  else attached.delete(paneId)
  emit()
}
export function clearAttachedTask(paneId: string) {
  if (!attached.delete(paneId)) return
  emit()
}

// ---- the launch ----

/** An image tile in the composer at the moment of sending. */
export interface LaunchImage { id: string; src: string; rect: LayoutRect }
/** The exits the frozen headline and pick-up play on the thread page. */
export interface ExitPaint { headline?: PaintTransformProps; pickup?: PaintTransformProps }

/** Geometry in pane coordinates (the conversation page's top-left), read once as Send is pressed. */
export interface Launch {
  paneId: string
  threadId: string
  /** The pane's window position (the real bubble reports window coordinates) and size. */
  paneX: number
  paneY: number
  paneWidth: number
  paneHeight: number
  /** The composer card's top in the draft. */
  cardTop: number
  cardHeight: number
  /** The editor's text box and its text, when the prompt can fly (≤ 6 bubble lines, not scrolled). */
  text: { value: string; rect: LayoutRect; lines: number } | null
  /** The prompt does not fly (too long, scrolled, or a task token heads the message): it fades where it was instead. */
  textFades: boolean
  /** Where the editor's text was and what it said (for the fade). */
  textRect: LayoutRect | null
  textValue: string
  /** The composer's image tiles. */
  images: LaunchImage[]
  /** They travel with the prompt onto the bubble's thumbnails; otherwise (over 4, or a task is attached) they fade in place. */
  imagesFly: boolean
  /** The tray, drawn once more above the thread card while it tucks away. */
  tray: ReactNode
  /** The headline and the pick-up, drawn frozen where they were while they dissolve. */
  exit: (paint: ExitPaint) => ReactNode
  at: number
}

let launch: Launch | null = null
/** `KYBERN_LAUNCH_LOG=1`: when Enter sent the new chat, so the thread page logs how long it took to open. */
let enterAt = 0
export function markLaunchEnter() { enterAt = performance.now() }
export function logLaunchOpened() {
  if (process.env.KYBERN_LAUNCH_LOG === '1' && enterAt) console.error(`[launch] enter→page ${(performance.now() - enterAt).toFixed(1)} ms`)
  enterAt = 0
}
/** Recorded when the send has a thread id, before the thread page mounts. */
export function setLaunch(next: Launch) { launch = next }
/** The thread page claims its launch once, on mount. The page opens on Enter (the thread id is the client's), so this runs in
 *  the same moment; the 3 s limit only drops a launch whose page never came (another pane or thread took over). */
export function takeLaunch(paneId: string, threadId: string | null): Launch | null {
  const found = launch
  if (!found || !threadId) return null
  if (found.paneId !== paneId || found.threadId !== threadId || performance.now() - found.at > 3000) return null
  launch = null
  return found
}

// ---- the hand-off to the real first message ----

/**
 * While a prompt flies, the thread's first user bubble mounts invisible at its final place and reports its text box and
 * image rects; the flight lands there, and the bubble shows itself in the same frame as the stand-in leaves.
 */
export interface MorphTarget { text: LayoutRect | null; images: LayoutRect[] }
interface Flight { threadId: string; claimed: string | null; target: MorphTarget | null; landed: boolean }
let flight: Flight | null = null
const flightListeners = new Set<() => void>()
const emitFlight = () => flightListeners.forEach((l) => l())
const subscribeFlight = (l: () => void) => { flightListeners.add(l); return () => { flightListeners.delete(l) } }

export function startFlight(threadId: string) { flight = { threadId, claimed: null, target: null, landed: false }; emitFlight() }
export function endFlight(threadId: string) {
  if (flight?.threadId !== threadId) return
  flight = { ...flight, landed: true }
  emitFlight()
}
export function clearFlight(threadId: string) {
  if (flight?.threadId !== threadId) return
  flight = null
  emitFlight()
}
/** The first fresh user bubble that asks claims the flight (`key` is its message id, or its timestamp); later bubbles render
 *  normally. The pending bubble claims it, and the daemon's copy of that message keeps the claim (same id, same row). */
export function claimFlight(key: string): boolean {
  if (!flight || flight.landed) return false
  if (flight.claimed && flight.claimed !== key) return false
  if (!flight.claimed) flight = { ...flight, claimed: key }
  return true
}
export function reportFlightTarget(key: string, target: MorphTarget) {
  if (!flight || flight.claimed !== key) return
  flight = { ...flight, target }
  emitFlight()
}
/** For the bubble: hidden while its flight is in the air. */
export function useFlightHidden(key: string, claimed: boolean): boolean {
  return useSyncExternalStore(subscribeFlight, () => claimed && !!flight && flight.claimed === key && !flight.landed)
}
/** For the morph layer: where the bubble reported it is. */
export function useFlightTarget(threadId: string): MorphTarget | null {
  return useSyncExternalStore(subscribeFlight, () => (flight?.threadId === threadId ? flight.target : null))
}
