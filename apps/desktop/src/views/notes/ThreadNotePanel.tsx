// The Notes section of a thread's Environment panel: the thread's note in the compact
// editor. The note is created when the first character is saved.
import { useEffect, useState } from "react"

import type { ThreadId } from "@/protocol"
import { migrateLegacyThreadDraft } from "@/state/notesLegacy"
import { useStore } from "@/state/store"
import { NoteEditor } from "./NoteEditor"

export function ThreadNotePanel({ threadId }: { threadId: ThreadId }) {
  const environmentId = useStore((s) => s.environmentId)
  const [migrated, setMigrated] = useState(false)
  // An unsaved draft from the old notes box moves over before the editor reads drafts.
  useEffect(() => {
    let live = true
    void migrateLegacyThreadDraft(environmentId, threadId).finally(() => live && setMigrated(true))
    return () => {
      live = false
    }
  }, [environmentId, threadId])
  // A soft fill rather than a frame, so an empty note still reads as somewhere to type.
  const field = "thread-note-field"
  if (!migrated) return <div className={`${field} min-h-24`} aria-hidden="true" />
  return <NoteEditor threadId={threadId} variant="compact" className={field} placeholder="Ideas, reminders, to-dos. Type / for formatting" />
}
