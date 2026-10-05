// Copy as Markdown and Export…, shared by the note's menus and the document's Share menu.
import { toast } from "sonner"

import { copyText } from "@/lib/hooks"
import { saveTextFile } from "@/lib/tauri"
import type { NoteSummary } from "@/protocol"
import { exportFileName, noteMarkdown } from "@/state/notesModel"
import { errorText } from "@/state/rpc"
import type { NoteText } from "./noteMenuKit"

/** The note as Markdown, plus the name an exported file gets. */
async function readMarkdown(note: NoteSummary, readText: () => NoteText | Promise<NoteText>) {
  const { title, body } = await readText()
  return { text: note.scope === "thread" ? body : noteMarkdown(title, body), fileName: exportFileName(note.scope === "thread" ? note.title : title) }
}

export function copyNoteMarkdown(note: NoteSummary, readText: () => NoteText | Promise<NoteText>) {
  readMarkdown(note, readText).then(
    ({ text }) => copyText(text).then(() => toast("Copied as Markdown")),
    (error) => toast.error("Unable to copy the note", { description: errorText(error) }),
  )
}

export function exportNoteFile(note: NoteSummary, readText: () => NoteText | Promise<NoteText>) {
  void (async () => {
    try {
      const { text, fileName } = await readMarkdown(note, readText)
      if (await saveTextFile(fileName, text)) toast(`Exported to ${fileName}`)
    } catch (error) {
      toast.error("Unable to export the note", { description: errorText(error) })
    }
  })()
}
