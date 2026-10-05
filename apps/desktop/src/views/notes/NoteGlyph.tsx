import { ChatBubbleIcon, NoteIcon } from "@/lib/kit/icons"
import type { NoteSummary } from "@/protocol"

/** A note's icon in lists and pickers: a chat bubble for a thread's note, the note glyph otherwise. */
export function NoteGlyph({ note, className }: { note: Pick<NoteSummary, "scope">; className?: string }) {
  return note.scope === "thread" ? <ChatBubbleIcon className={className} /> : <NoteIcon className={className} />
}
