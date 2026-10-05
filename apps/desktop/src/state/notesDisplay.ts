// How the Notes gallery is shown: the filter, Gallery or List, grouping, sort, the
// hint bar, and the document outline. Display choices are a per-viewer convenience
// kept in localStorage; the filter lasts for the session only, so Notes opens on All.
import { create } from "zustand"

import { reloadOnHotUpdate } from "@/lib/hot"
import { setSectionFocus } from "./notes"
import type { NotesFilter, NotesGroupBy, NotesSortBy } from "./notesModel"

export type NotesLayout = "gallery" | "list"

interface Display {
  layout: NotesLayout
  group: NotesGroupBy
  sort: NotesSortBy
  /** The quiet keyboard hint bar under the gallery. */
  hints: boolean
  /** The document outline stays open in the margin (otherwise it is a rail that opens on hover). */
  outline: boolean
}

interface NotesDisplayState extends Display {
  filter: NotesFilter
}

const KEY = "kybern.notes.display"
const DEFAULTS: Display = { layout: "gallery", group: "none", sort: "edited", hints: true, outline: true }

function read(): Display {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "null") as Partial<Display> | null
    if (!value || typeof value !== "object") return DEFAULTS
    return {
      layout: value.layout === "list" ? "list" : "gallery",
      group: value.group === "date" || value.group === "project" ? value.group : "none",
      sort: value.sort === "created" || value.sort === "title" ? value.sort : "edited",
      hints: value.hints !== false,
      outline: value.outline !== false,
    }
  } catch {
    return DEFAULTS
  }
}

export const useNotesDisplay = create<NotesDisplayState>()(() => ({ ...read(), filter: { kind: "all" } }))

/** Change a display choice and remember it. */
export function setNotesDisplay(patch: Partial<Display>) {
  useNotesDisplay.setState(patch)
  const { layout, group, sort, hints, outline } = useNotesDisplay.getState()
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify({ layout, group, sort, hints, outline }))
  } catch {
    /* The choice still applies to this window. */
  }
}

/** Choose a filter; new notes then go where you are looking. */
export function chooseFilter(filter: NotesFilter) {
  useNotesDisplay.setState({ filter })
  setSectionFocus(filter.kind === "global" ? { kind: "global" } : filter.kind === "project" ? { kind: "project", projectId: filter.projectId } : null)
}

reloadOnHotUpdate(import.meta.hot)
