// "Save to note": the hover action on messages. One picker serves every message; the
// message row only says what to save and where the picker should appear, so rows
// carry no subscriptions of their own.
import { toast } from "sonner"
import { create } from "zustand"

import { isFreeChatProject, type NoteId, type ThreadId } from "@/protocol"
import { appendToNote, createNote, openNote } from "./notes"
import { noteTitle, savedMessageMarkdown, titleFromText, type NoteHome } from "./notesModel"
import { errorText } from "./rpc"
import { useStore } from "./store"

export interface SaveRequest {
  /** The button the picker opens beside. */
  anchor: HTMLElement
  threadId: ThreadId
  /** The message's Markdown, or the text selected inside it. */
  text: string
  /** True when `text` is a selection rather than the whole message. */
  selection: boolean
}

interface SaveToNoteState {
  open: boolean
  request: SaveRequest | null
}

export const useSaveToNote = create<SaveToNoteState>()(() => ({ open: false, request: null }))

export function openSaveToNote(request: SaveRequest) {
  useSaveToNote.setState({ open: true, request })
}

export function closeSaveToNote() {
  useSaveToNote.setState({ open: false })
}

/** The text to save: a selection made inside the message wins over the whole message. */
export function textToSave(button: HTMLElement, message: string): Pick<SaveRequest, "text" | "selection"> {
  const selection = globalThis.getSelection?.()
  const selected = selection?.toString().trim()
  if (selection && selected && !selection.isCollapsed) {
    const row = button.closest(".group")
    if (row && selection.anchorNode && selection.focusNode && row.contains(selection.anchorNode) && row.contains(selection.focusNode)) return { text: selected, selection: true }
  }
  return { text: message, selection: false }
}

function threadTitle(threadId: ThreadId): string {
  return useStore.getState().threads[threadId]?.title ?? ""
}

/** Where a new note made from this thread goes: its project, or Global for a free chat. */
function homeForThread(threadId: ThreadId): NoteHome {
  const projectId = useStore.getState().threads[threadId]?.project_id
  const known = projectId && projectId in useStore.getState().projects ? projectId : null
  return known && !isFreeChatProject(known) ? { scope: "project", projectId: known } : { scope: "global" }
}

function saved(id: NoteId, label: string) {
  toast(`Saved to “${label}”`, { action: { label: "Open", onClick: () => openNote(id) } })
}

/** Add the message to an existing note, below what is already there. */
export async function saveToExistingNote(request: SaveRequest, id: NoteId, label: string) {
  try {
    const note = await appendToNote(id, savedMessageMarkdown(request.text, threadTitle(request.threadId), request.threadId))
    saved(note.id, label)
  } catch (error) {
    toast.error("Unable to save to the note", { description: errorText(error) })
  }
}

/** Start a note from the message, titled from its first line. */
export async function saveToNewNote(request: SaveRequest) {
  try {
    const title = titleFromText(request.text) || "Untitled"
    const { note } = await createNote(homeForThread(request.threadId), {
      title,
      body: `${savedMessageMarkdown(request.text, threadTitle(request.threadId), request.threadId)}\n`,
    })
    saved(note.id, noteTitle(note))
  } catch (error) {
    toast.error("Unable to create the note", { description: errorText(error) })
  }
}
