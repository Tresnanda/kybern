// "Make task" from a note's checklist line. The note is saved first, so the daemon
// finds the line; it then makes the task (To do, in the note's project or Global,
// titled with the line's text), ends the line with the task's link and broadcasts
// the note, which the open editor folds in without moving the caret.
import type { Editor } from "@tiptap/core"
import { toast } from "sonner"

import type { NoteId, ProjectId } from "@/protocol"
import { checklistLine } from "@/state/noteLines"
import { createTaskFromNoteLine, getTask, openTask } from "@/state/tasks"
import { TASK_ITEM, lineTaskRef } from "./taskLinks"
import { tidyMarkdown } from "./tidyMarkdown"

export interface NoteTaskContext {
  noteId: NoteId
  /** Where new tasks go: the note's project, or null for Global. */
  projectId: ProjectId | null
  /** Save the note and wait for the daemon to have it. False when it could not be saved. */
  saveNow(): Promise<boolean>
}

const making = new Set<string>()

const lineTitle = (text: string) => text.replace(/\s+/g, " ").trim()

/** True while this line's text is being made into a task, so it is not offered twice. */
export const isMakingTask = (text: string) => making.has(lineTitle(text))

/** Which checklist item this is, counting every item in the document in order. */
function checklistIndex(editor: Editor, itemPos: number): number {
  let index = -1
  let found = -1
  editor.state.doc.descendants((node, pos) => {
    if (found >= 0) return false
    if (node.type.name === TASK_ITEM) {
      index++
      if (pos === itemPos) found = index
    }
    return true
  })
  return found
}

export async function makeTaskFromLine(editor: Editor, itemPos: number, context: NoteTaskContext) {
  const item = editor.state.doc.nodeAt(itemPos)
  const line = item?.type.name === TASK_ITEM ? item.firstChild : null
  if (!item || !line?.isTextblock) return
  const linked = lineTaskRef(line)
  if (linked) {
    const task = getTask(linked.attrs.id)
    toast(`This line is already ${task?.key ?? linked.attrs.label}`, task ? { action: { label: "Open", onClick: () => openTask(task.id) } } : undefined)
    return
  }
  const title = lineTitle(line.textContent)
  if (!title) {
    toast("Write the line first, then make it a task")
    return
  }
  if (item.attrs.checked) {
    toast("This line is already done", { description: "Untick it to make it a task." })
    return
  }
  if (making.has(title)) return
  const index = checklistIndex(editor, itemPos)
  making.add(title)
  // Hide the affordance on this line while the task is made.
  editor.view.dispatch(editor.state.tr.setMeta("addToHistory", false))
  try {
    if (!(await context.saveNow())) {
      toast.error("Unable to make a task", { description: "This note has changes that are not saved yet. Save it, then try again." })
      return
    }
    // The line as the saved Markdown has it, which is what the daemon looks for.
    const markdown = editor.isDestroyed || !editor.markdown ? null : tidyMarkdown(editor.getMarkdown())
    const lineText = (markdown && index >= 0 ? checklistLine(markdown, index) : null) ?? title
    const task = await createTaskFromNoteLine({ noteId: context.noteId, lineText, title, projectId: context.projectId })
    if (task) toast(`${task.key} created`, { action: { label: "Open", onClick: () => openTask(task.id) } })
  } finally {
    making.delete(title)
    if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta("addToHistory", false))
  }
}
