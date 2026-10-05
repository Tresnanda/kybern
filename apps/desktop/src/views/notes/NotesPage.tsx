// The Notes page: the gallery of every note, or one note as a focused document.
// Notes use the whole workspace card, so the thread panel steps aside while the
// page is open (⌘B still brings it back) and returns as it was when you leave.
import { useEffect } from "react"

import { useNoteSummary, useNotes, useNotesReady } from "@/state/notes"
import { useStore } from "@/state/store"
import { NoteEditor } from "./NoteEditor"
import { NotesGallery } from "./NotesGallery"

export function NotesView() {
  const noteId = useStore((s) => (s.selected.kind === "notes" ? s.selected.noteId : undefined))
  const summary = useNoteSummary(noteId)
  const { loaded } = useNotesReady()

  useEffect(() => {
    if (noteId) useNotes.setState({ lastOpenId: noteId })
  }, [noteId])

  // The thread panel steps aside for Notes and comes back as it was.
  useEffect(() => {
    const wasOpen = useStore.getState().sidebarOpen
    if (wasOpen) useStore.getState().set({ sidebarOpen: false })
    return () => {
      if (wasOpen) useStore.getState().set({ sidebarOpen: true })
    }
  }, [])

  // A note that is gone (purged elsewhere, or on another environment) leaves the gallery showing.
  const missing = !!noteId && loaded && !summary
  useEffect(() => {
    if (missing) useStore.getState().selectNotes()
  }, [missing])

  if (noteId && !missing) {
    return summary ? <NoteEditor noteId={noteId} onDeleted={() => useStore.getState().selectNotes()} /> : <div className="notes-page" />
  }
  return <NotesGallery />
}
