// The card under an agent's note or task write in the transcript: what it filed or
// changed, where it lives, and a way to open it. A create can be undone from here;
// the undo is a soft delete, so "Restore" brings it back. The card reads the live
// item so a rename or status change shows, and says "Deleted" once it is gone.
// It keeps one height in every state, so a transcript row never shifts under it.
import { memo, type CSSProperties } from "react"

import { Spinner } from "@/components/kybern/bits"
import { ReviewChangesButton } from "@/components/kit/chat/ReviewChangesButton"
import { agentItemChangeSummary, type AgentNoteResult, type AgentTaskResult } from "@/lib/agentItemTools"
import { ListChecksIcon, NoteIcon, Undo2Icon } from "@/lib/kit/icons"
import { useTranscriptRowState } from "@/lib/transcriptRowState"
import { cn } from "@/lib/utils"
import { isFreeChatProject, type TaskStatus } from "@/protocol"
import { deleteNote, openNote, restoreNote, useNotes } from "@/state/notes"
import { useStore } from "@/state/store"
import { deleteTask, openTask, restoreTask, useTasks } from "@/state/tasks"
import { STATUS_LABEL } from "@/state/tasksModel"

/** Local to this card while the transcript is open; never saved. */
type UndoState = "idle" | "removing" | "removed" | "restoring"

const ACTION_CLASS = "flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-60"

/** `inset` lines the card up under a tool row; under an answer it sits flush with the text. */
export const AgentItemCard = memo(function AgentItemCard({ result, style, inset = true }: { result: AgentNoteResult | AgentTaskResult; style?: CSSProperties; inset?: boolean }) {
  const [undo, setUndo] = useTranscriptRowState<UndoState>(`agent-item:${result.kind}:${result.id}`, "idle")
  const liveTask = useTasks((s) => (result.kind === "task" ? s.tasks[result.id] : undefined))
  const tasksLoaded = useTasks((s) => s.loaded && s.supported)
  const liveNote = useNotes((s) => (result.kind === "note" ? s.env.notes[result.id] ?? s.home.notes[result.id] : undefined))
  const notesLoaded = useNotes((s) => s.env.loaded && s.env.supported)

  const live = result.kind === "task" ? liveTask : liveNote
  const loaded = result.kind === "task" ? tasksLoaded : notesLoaded
  const deletedNote = result.kind === "note" && !!liveNote?.deleted_at
  // Gone only once the list is read; until then the result's own copy stands in.
  const gone = loaded && (!live || deletedNote)
  const removed = undo === "removed" || undo === "restoring"
  const muted = removed || (gone && undo === "idle")

  const projectId = (result.kind === "task" ? liveTask?.project_id : liveNote?.project_id) ?? result.projectId
  const projectName = useStore((s) => (projectId && !isFreeChatProject(projectId) ? s.projects[projectId]?.name : undefined))

  const title = (live?.title ?? result.title).trim() || (result.kind === "task" ? "Untitled task" : "Untitled note")
  const key = result.kind === "task" ? liveTask?.key ?? result.key : ""
  const label = key ? `${key} ${title}` : title

  let meta: string
  if (removed) meta = "Removed"
  else if (gone) meta = "Deleted"
  else {
    const parts: string[] = []
    if (result.kind === "task") {
      const status = (liveTask?.status ?? result.status) as TaskStatus
      if (STATUS_LABEL[status]) parts.push(STATUS_LABEL[status])
      parts.push(projectName ?? (projectId && !isFreeChatProject(projectId) ? "Project" : "Global"))
      if (result.criteriaTotal > 0) parts.push(`${result.criteriaDone}/${result.criteriaTotal} criteria`)
    } else {
      const scope = liveNote?.scope ?? result.scope
      parts.push(scope === "thread" ? "This chat’s note" : projectName ?? (scope === "global" ? "Global" : "Project"))
    }
    const change = agentItemChangeSummary(result)
    if (change) parts.push(change)
    meta = parts.join(" · ")
  }

  const open = () => (result.kind === "task" ? openTask(result.id) : openNote(result.id))
  const remove = async () => {
    setUndo("removing")
    const ok = result.kind === "task" ? await deleteTask(result.id, { quiet: true }) : await deleteNote(result.id, { quiet: true })
    setUndo(ok ? "removed" : "idle")
  }
  const restore = async () => {
    setUndo("restoring")
    const ok = result.kind === "task" ? (await restoreTask(result.id)) !== null : await restoreNote(result.id)
    setUndo(ok ? "idle" : "removed")
  }

  const canUndo = result.action === "created" && !gone && (undo === "idle" || undo === "removing")
  const Icon = result.kind === "task" ? ListChecksIcon : NoteIcon

  return (
    <div
      data-agent-item={result.id}
      className={cn("chat-paint-host flex", inset && "ms-[1.375rem] mt-1 mb-1", "min-h-[3.25rem] items-center gap-3 rounded-[0.65rem] border border-[color:var(--color-border-light)] bg-[color:color-mix(in_srgb,var(--app-chat-code-surface)_40%,transparent)] px-3 py-2 dark:border-[color:color-mix(in_srgb,var(--color-border-light)_55%,transparent)]")}
    >
      <Icon aria-hidden className={cn("size-4 shrink-0", muted ? "text-muted-foreground/45" : "text-muted-foreground/70")} />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-baseline gap-1.5 leading-5" style={style} title={label}>
          {key && <span className="shrink-0 font-system-ui text-[12px] tabular-nums text-muted-foreground/70">{key}</span>}
          <span className={cn("min-w-0 truncate", muted ? "text-muted-foreground/70" : "text-foreground/92")}>{title}</span>
        </p>
        <p className={cn("truncate font-system-ui text-[11.5px] leading-5", muted ? "text-muted-foreground/55" : "text-muted-foreground/70")} aria-live="polite">
          {meta}
        </p>
      </div>
      {/* Actions keep their slot in every state so the title never reflows. */}
      <div className="flex shrink-0 items-center gap-3 font-system-ui text-[12px]">
        {canUndo && (
          <button type="button" className={ACTION_CLASS} disabled={undo === "removing"} onClick={() => void remove()} aria-label={`Undo: remove ${label}`}>
            Undo {undo === "removing" ? <Spinner size={12} /> : <Undo2Icon className="size-3" />}
          </button>
        )}
        {removed && (
          <button type="button" className={ACTION_CLASS} disabled={undo === "restoring"} onClick={() => void restore()} aria-label={`Restore ${label}`}>
            Restore {undo === "restoring" && <Spinner size={12} />}
          </button>
        )}
        {!muted && <ReviewChangesButton label="Open" onClick={open} className="text-[12px]" />}
      </div>
    </div>
  )
})
