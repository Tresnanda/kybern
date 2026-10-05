// Quick capture (⌘⇧N): a small panel that writes a new note without leaving what
// you were doing. The text lives here, not in the panel, so closing the panel never
// loses it: it is kept in localStorage until the note is saved, and a note that
// fails to save comes back the next time the panel opens.
import { toast } from "sonner"
import { create } from "zustand"

import { currentNewNoteHome, createNote, deleteNote, openNote } from "./notes"
import { titleFromText, type NoteHome } from "./notesModel"
import { errorText } from "./rpc"
import { useStore } from "./store"

interface QuickNoteState {
  open: boolean
  title: string
  body: string
  home: NoteHome
}

const DRAFT_KEY = "kybern.notes.quick"

export const useQuickNote = create<QuickNoteState>()(() => ({ open: false, title: "", body: "", home: { scope: "global" } }))

function readDraft(): Pick<QuickNoteState, "title" | "body"> & { home: NoteHome | null } | null {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(DRAFT_KEY) ?? "null")
    if (!value || typeof value.title !== "string" || typeof value.body !== "string") return null
    const home: NoteHome | null =
      value.home?.scope === "project" && typeof value.home.projectId === "string"
        ? { scope: "project", projectId: value.home.projectId }
        : value.home?.scope === "global"
          ? { scope: "global" }
          : null
    return { title: value.title, body: value.body, home }
  } catch {
    return null
  }
}

function writeDraft() {
  const { title, body, home } = useQuickNote.getState()
  try {
    if (!title && !body) globalThis.localStorage?.removeItem(DRAFT_KEY)
    else globalThis.localStorage?.setItem(DRAFT_KEY, JSON.stringify({ title, body, home }))
  } catch {
    /* The text is still in the panel. */
  }
}

function clearDraft() {
  try {
    globalThis.localStorage?.removeItem(DRAFT_KEY)
  } catch {
    /* Nothing to clear. */
  }
}

/** Open the panel, with a scope that follows what is on screen and any text left from last time. */
export function openQuickNote() {
  if (useQuickNote.getState().open) return
  const draft = readDraft()
  const projects = useStore.getState().projects
  const fallback = currentNewNoteHome()
  const home = draft?.home && (draft.home.scope === "global" || draft.home.projectId in projects) ? draft.home : fallback
  useQuickNote.setState({ open: true, title: draft?.title ?? "", body: draft?.body ?? "", home })
}

export function setQuickNote(patch: Partial<Pick<QuickNoteState, "title" | "body" | "home">>) {
  useQuickNote.setState(patch)
  writeDraft()
}

/**
 * Close the panel. Saving creates the note unless the panel is empty; nothing is
 * ever created from an empty panel.
 */
export async function closeQuickNote(save: boolean) {
  const { open, title, body, home } = useQuickNote.getState()
  if (!open) return
  useQuickNote.setState({ open: false })
  if (!save || (!title.trim() && !body.trim())) {
    clearDraft()
    return
  }
  try {
    const { note } = await createNote(home, { title: title.trim(), body: body.trim() ? `${body.trim()}\n` : "" })
    clearDraft()
    // Say where it went, and give a way back: Undo moves it to Recently deleted.
    const where = home.scope === "project" ? useStore.getState().projects[home.projectId]?.name ?? "Notes" : "Global"
    toast(`Saved to ${where}`, {
      description: title.trim() ? titleFromText(title) : titleFromText(body),
      action: { label: "Open", onClick: () => openNote(note.id) },
      cancel: { label: "Undo", onClick: () => void deleteNote(note.id, { quiet: true }) },
    })
  } catch (error) {
    // The text stays in the draft, so reopening puts it back.
    toast.error("Unable to save the note", {
      description: errorText(error),
      action: { label: "Reopen", onClick: () => openQuickNote() },
    })
  }
}
