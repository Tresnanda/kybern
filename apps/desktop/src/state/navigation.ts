// Back and forward through the main views. The steps themselves are recorded by the
// store (see `navHistory.ts`); this module decides which of them can still be shown,
// restores one, and wires the keyboard, mouse buttons and the arrows in the chrome.

import { useCallback, useEffect, useSyncExternalStore } from "react"

import { useHotkey } from "@/lib/hooks"
import { canMoveNavHistory, type NavEntry } from "./navHistory"
import { isHomeShared, locateNote, useNotes } from "./notes"
import { selectsMissingProject } from "./projects"
import { loadThread } from "./rpc"
import { useStore, type AppState } from "./store"
import { useTasks } from "./tasks"

/**
 * Whether a recorded view can still be shown. Deleted threads, notes and tasks are
 * skipped; archived threads still open. Until a list has loaded nothing is dropped.
 */
export function isNavEntryValid(entry: NavEntry, state: AppState = useStore.getState()): boolean {
  switch (entry.kind) {
    case "thread":
      return state.info === null || !!state.threads[entry.id]
    case "draft":
      return !selectsMissingProject(entry, state.projects)
    case "pulls":
    case "usage":
      return true
    case "notes":
      return !entry.noteId || noteExists(entry.noteId)
    case "tasks": {
      if (!entry.taskId) return true
      const tasks = useTasks.getState()
      return !tasks.loaded || !!tasks.tasks[entry.taskId]
    }
    default: {
      const unknown: never = entry
      throw new Error(`Unhandled navigation entry: ${JSON.stringify(unknown)}`)
    }
  }
}

function noteExists(noteId: string): boolean {
  const notes = useNotes.getState()
  if (!notes.env.loaded) return true
  const found = locateNote(noteId)
  if (found) return !found.summary.deleted_at
  // A global note may still be on its way from This Mac.
  return isHomeShared() && !notes.home.loaded && notes.home.status !== "unreachable"
}

/** Close Settings if it is open, otherwise step to the nearest valid view. True when something changed. */
export function goBack(): boolean {
  const state = useStore.getState()
  if (state.settingsOpen) {
    state.set({ settingsOpen: false })
    return true
  }
  return move(-1)
}

/** Forward is not offered while Settings covers the view: it would change the page out of sight. */
export function goForward(): boolean {
  if (useStore.getState().settingsOpen) return false
  return move(1)
}

function move(delta: -1 | 1): boolean {
  const state = useStore.getState()
  const entry = state.moveNavigation(delta, (candidate) => isNavEntryValid(candidate))
  if (!entry) return false
  // A thread restored from history may never have been opened in this window.
  if (entry.kind === "thread") void loadThread(entry.id)
  return true
}

interface NavigationAvailability {
  canBack: boolean
  canForward: boolean
}

// 0: neither, 1: back, 2: forward, 3: both. A primitive keeps subscribers quiet
// until an arrow actually changes.
function availability(): number {
  const state = useStore.getState()
  const isValid = (entry: NavEntry) => isNavEntryValid(entry, state)
  const back = state.settingsOpen || canMoveNavHistory(state.navHistory, -1, isValid)
  const forward = !state.settingsOpen && canMoveNavHistory(state.navHistory, 1, isValid)
  return (back ? 1 : 0) + (forward ? 2 : 0)
}

/** Which arrows have somewhere to go. Notes and tasks are watched too: deleting one can end a trail. */
export function useNavigationAvailability(): NavigationAvailability {
  const store = useStore
  const subscribe = useCallback(
    (notify: () => void) => {
      const stops = [store.subscribe(notify), useNotes.subscribe(notify), useTasks.subscribe(notify)]
      return () => stops.forEach((stop) => stop())
    },
    [store],
  )
  const value = useSyncExternalStore(subscribe, availability, availability)
  return { canBack: (value & 1) !== 0, canForward: (value & 2) !== 0 }
}

/** ⌘[ and ⌘], and the mouse's back and forward buttons. Mount once, at the app root. */
export function useNavigationShortcuts() {
  const paletteOpen = useStore((s) => s.paletteOpen)
  useHotkey("mod+[", () => void goBack(), { allowInInput: true, enabled: !paletteOpen })
  useHotkey("mod+]", () => void goForward(), { allowInInput: true, enabled: !paletteOpen })

  useEffect(() => {
    if (paletteOpen) return
    // Buttons 3 and 4 are the mouse's back and forward. `mouseup` navigates; the
    // follow-up `auxclick` only has its default action cancelled.
    const onMouseUp = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return
      event.preventDefault()
      if (event.button === 3) goBack()
      else goForward()
    }
    const cancel = (event: MouseEvent) => {
      if (event.button === 3 || event.button === 4) event.preventDefault()
    }
    window.addEventListener("mouseup", onMouseUp)
    window.addEventListener("mousedown", cancel)
    window.addEventListener("auxclick", cancel)
    return () => {
      window.removeEventListener("mouseup", onMouseUp)
      window.removeEventListener("mousedown", cancel)
      window.removeEventListener("auxclick", cancel)
    }
  }, [paletteOpen])
}
