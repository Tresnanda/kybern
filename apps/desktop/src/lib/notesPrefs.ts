// Where global notes live. An app-wide preference, not a per-environment one:
// "shared" shows the notes of this Mac in every environment window; "separate"
// shows each environment's own. Switching never moves or deletes a note.
import { useSyncExternalStore } from "react"

export type GlobalNotesHome = "shared" | "separate"

export const GLOBAL_NOTES_HOME_KEY = "kybern.notes.globalHome"

function read(): GlobalNotesHome {
  try {
    return globalThis.localStorage?.getItem(GLOBAL_NOTES_HOME_KEY) === "separate" ? "separate" : "shared"
  } catch {
    return "shared"
  }
}

let current: GlobalNotesHome = read()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())

export function getGlobalNotesHome(): GlobalNotesHome {
  return current
}

export function setGlobalNotesHome(value: GlobalNotesHome): void {
  if (value === current) return
  current = value
  try {
    globalThis.localStorage?.setItem(GLOBAL_NOTES_HOME_KEY, value)
  } catch {
    /* The choice still applies to this window. */
  }
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Another window changed the preference.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== GLOBAL_NOTES_HOME_KEY) return
    const next = read()
    if (next === current) return
    current = next
    emit()
  })
}

export function useGlobalNotesHome(): GlobalNotesHome {
  return useSyncExternalStore(subscribe, getGlobalNotesHome, getGlobalNotesHome)
}
