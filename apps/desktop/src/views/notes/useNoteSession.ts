import { useEffect, useState, useSyncExternalStore } from "react"

import type { NoteId, ThreadId } from "@/protocol"
import { locateNote } from "@/state/notes"
import { NoteSession, type NoteTarget } from "@/state/noteSession"

/** One session per mounted editor: it loads the note, saves edits, and flushes on unmount. */
export function useNoteSession(target: { noteId?: NoteId; threadId?: ThreadId }) {
  const [session] = useState(() => {
    const note: NoteTarget = target.noteId ? { kind: "note", id: target.noteId } : { kind: "thread", threadId: target.threadId! }
    return new NoteSession(note, note.kind === "note" ? locateNote(note.id)?.source ?? "env" : "env")
  })
  useEffect(() => {
    session.attach()
    return () => session.detach()
  }, [session])
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  return { session, snapshot }
}
