// A `kybern://note/<id>` or `kybern://task/<id>` reference in a message, drawn as
// the same chip a sent @mention uses. The label follows the item (a rename shows
// without a refresh); before the lists arrive it falls back to the link's own
// label, so a chip never flashes "Deleted" while data loads. Once a list is read
// and the item is not in it, the chip says it is gone and stops being a link.

import { InlineToken } from "@/components/kybern/InlineToken"
import { openNote, useNotes } from "@/state/notes"
import { openTask, useTasks } from "@/state/tasks"
import type { KybernRef } from "../../../../../packages/kybern-client/src/chatLinks"

/** The text of a link that is just its own URI says nothing more than "a note". */
function writtenLabel(label: string): string {
  const text = label.replace(/\s+/g, " ").trim()
  return /^kybern:\/\//i.test(text) ? "" : text
}

export function KybernRefChip({ target, id, label }: KybernRef & { label: string }) {
  return target === "task" ? <TaskRefChip id={id} label={label} /> : <NoteRefChip id={id} label={label} />
}

function TaskRefChip({ id, label }: { id: string; label: string }) {
  const task = useTasks((state) => state.tasks[id])
  const supported = useTasks((state) => state.supported)
  const loaded = useTasks((state) => state.loaded)
  const written = writtenLabel(label)
  if (!task) {
    if (loaded && supported) return <InlineToken kind="task" text="@" display="Deleted task" label="This task was deleted" gone />
    return <InlineToken kind="task" text="@" display={written || "Task"} onClick={supported ? () => openTask(id) : undefined} />
  }
  const name = [task.key, task.title.trim()].filter(Boolean).join(" ") || written || "Task"
  return <InlineToken kind="task" text="@" display={name} label={`Open ${name}`} onClick={() => openTask(id)} />
}

function NoteRefChip({ id, label }: { id: string; label: string }) {
  const note = useNotes((state) => state.env.notes[id] ?? state.home.notes[id])
  const supported = useNotes((state) => state.env.supported)
  // Gone only once every list that could hold it has been read.
  const known = useNotes((state) => state.env.loaded && state.env.supported && (state.home.status === "off" || (state.home.status === "ready" && state.home.loaded)))
  const written = writtenLabel(label)
  if (!note || note.deleted_at) {
    if (known) return <InlineToken kind="note" text="@" display="Deleted note" label="This note was deleted" gone />
    return <InlineToken kind="note" text="@" display={written || "Note"} onClick={supported ? () => openNote(id) : undefined} />
  }
  const name = note.title.trim() || written || "Untitled note"
  return <InlineToken kind="note" text="@" display={name} label={`Open ${name}`} onClick={() => openNote(id)} />
}
