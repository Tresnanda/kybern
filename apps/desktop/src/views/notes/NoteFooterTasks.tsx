// "Linked tasks" in a note's footer strip: each task that uses this note as context,
// was made from one of its checklist lines or is referenced in its text, as its
// status glyph, key and status word, most urgent first. A click opens the task.
// Nothing shows when no task links here.
import { useMemo } from "react"

import type { NoteId } from "@/protocol"
import { openTask, useAllTasks } from "@/state/tasks"
import { LIST_STATUS_ORDER, STATUS_LABEL } from "@/state/tasksModel"
import { TaskStatusGlyph } from "../tasks/TaskGlyphs"

/** Tasks named in the strip; the rest are counted. */
const SHOWN = 4

export function NoteFooterTasks({ noteId, referenced }: { noteId: NoteId | null; referenced: ReadonlySet<string> }) {
  const tasks = useAllTasks()
  const linked = useMemo(() => {
    if (!noteId && referenced.size === 0) return []
    return tasks
      .filter((task) => (noteId && (task.source_note_id === noteId || task.note_ids.includes(noteId))) || referenced.has(task.id))
      .sort((a, b) => LIST_STATUS_ORDER.indexOf(a.status) - LIST_STATUS_ORDER.indexOf(b.status) || a.rank - b.rank)
  }, [tasks, noteId, referenced])
  if (linked.length === 0) return null
  const rest = linked.length - SHOWN
  return (
    <>
      <span className="note-footer-label">Linked tasks</span>
      {linked.slice(0, SHOWN).map((task) => (
        <button key={task.id} type="button" className="note-footer-item" title={task.title} onClick={() => openTask(task.id)}>
          <TaskStatusGlyph status={task.status} size={12} />
          <span className="tabular-nums">{task.key}</span>
          <span className="note-footer-quiet">{STATUS_LABEL[task.status]}</span>
        </button>
      ))}
      {rest > 0 && <span className="note-footer-quiet tabular-nums">{rest} more</span>}
    </>
  )
}
