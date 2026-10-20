import { onEnvironmentChange } from './environment.ts'
// The thread panel's width (`App.tsx:170-183` in the desktop): resizable by drag
// between 208 and 480px, saved under the desktop's own key, and on a narrow
// window it gives way before the dock does. The content column keeps room for
// the dock's minimum width beside the rail and the frame inset; the saved width
// comes back when the window widens again.
//
// Reading the width is cheap (a number), and a drag only moves that number: the
// window frame, not the transcript, is what re-lays out per pixel.
import { useSyncExternalStore } from 'react'
import { load, save } from './persist.ts'

export const SIDEBAR_MIN = 208
export const SIDEBAR_MAX = 480
export const SIDEBAR_DEFAULT = 256
/** `RIGHT_DOCK_MIN_WIDTH` (26rem): the chat column keeps this much for the dock. */
export const DOCK_MIN = 416
/** The 52px app rail (`nav/TitleBar.tsx` `RAIL`) and the 8px frame inset (`App.tsx` `INSET`). */
const RAIL_WIDTH = 52
const FRAME_INSET = 8

const KEY = 'kybern.sidebar.width'
// A non-finite width (a pointer event without coordinates) would reach the native layout as NaN; keep the last width instead.
const clamp = (w: number) => (Number.isFinite(w) ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(w))) : stored)

const saved = Number(load<number>(KEY, SIDEBAR_DEFAULT))
// `KYBERN_SIDEBAR_WIDTH` lets the pair tool match the reference window's stored width.
const forced = Number(process.env.KYBERN_SIDEBAR_WIDTH)
let stored = forced >= SIDEBAR_MIN && forced <= SIDEBAR_MAX ? forced : saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX ? saved : SIDEBAR_DEFAULT
/** 0 until the first window-size reading: no narrow-window shrink before it. */
let windowWidth = 0
let dragging = false
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

/** The width the panel takes now: the saved one, shrunk on a narrow window. */
export function effectiveSidebarWidth(): number {
  if (!windowWidth) return stored
  return Math.max(SIDEBAR_MIN, Math.min(stored, windowWidth - RAIL_WIDTH - FRAME_INSET - DOCK_MIN))
}

export function useSidebarWidth(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    effectiveSidebarWidth,
  )
}

export function useSidebarDragging(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => dragging,
  )
}

/** Called by the window poller whenever the window's width changes. */
export function setWindowWidth(width: number) {
  if (width === windowWidth) return
  windowWidth = width
  // Subscribers select their own value, so only those whose value changed re-render.
  emit()
}

/** The window's width from the shell's poller; 0 before the first reading. */
export const getWindowWidth = () => windowWidth

export function useWindowWidth(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    getWindowWidth,
  )
}

/** Follow the pointer; the width is saved when the drag ends. */
export function dragSidebarTo(width: number) {
  const next = clamp(width)
  if (next === stored) return
  stored = next
  emit()
}

export function setSidebarDragging(next: boolean) {
  if (dragging === next) return
  dragging = next
  if (!next) save(KEY, stored)
  emit()
}

export const storedSidebarWidth = () => stored

onEnvironmentChange(() => { const value = Number(load(KEY, SIDEBAR_DEFAULT)); stored = Number.isFinite(value) ? clamp(value) : SIDEBAR_DEFAULT; dragging = false; emit() })
