// One note in the gallery: a miniature of its content, then its title and a quiet
// meta line (age, where it lives, checklist progress). The list layout's row says
// the same in one line. Both open the note on click or Enter and carry the note's
// menu on right-click.
import { memo } from "react"

import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu"
import { ChecklistRing, ProjectDot } from "@/lib/kit/projectDot"
import { MessageCircleIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import type { NoteSummary } from "@/protocol"
import { openNote } from "@/state/notes"
import { ageLabel, noteTitle, purgeLabel, splitMatches } from "@/state/notesModel"
import { useStore } from "@/state/store"
import { useTaskRef } from "@/state/tasks"
import { standaloneTaskKeys } from "@/state/tasksModel"
import { TaskStatusGlyph } from "../tasks/TaskGlyphs"
import { NoteMenuItems } from "./NoteMenu"
import { NoteThumb } from "./NoteThumb"
import { CONTEXT_KIT, readNoteText } from "./noteMenuKit"

export interface NoteScopeInfo {
  /** The project the dot is colored for; null for Global. */
  projectId: string | null
  name: string
}

interface ItemProps {
  note: NoteSummary
  scope: NoteScopeInfo
  /** The one card in the tab order. */
  tabStop: boolean
  now: number
  query?: string
  /** A search hit's context, in place of the preview (list rows). */
  snippet?: string | null
  onPurge: (note: NoteSummary) => void
}

function Highlight({ text, query }: { text: string; query?: string }) {
  if (!query?.trim()) return <>{text}</>
  return (
    <>
      {splitMatches(text, query).map((part, index) =>
        part.match ? (
          <mark key={index} className="notes-mark">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  )
}

/** A key in a row's excerpt: with its task's status glyph when it names a task. */
function ExcerptKey({ taskKey, query }: { taskKey: string; query?: string }) {
  const task = useTaskRef(taskKey)
  if (!task) return <Highlight text={taskKey} query={query} />
  return (
    <span className="note-row-task">
      <TaskStatusGlyph status={task.status} size={11} />
      <Highlight text={taskKey} query={query} />
    </span>
  )
}

/** The excerpt, with task keys drawn as small references. */
function Excerpt({ text, query }: { text: string; query?: string }) {
  const keys = standaloneTaskKeys(text)
  if (keys.length === 0) return <Highlight text={text} query={query} />
  const parts: React.ReactNode[] = []
  let at = 0
  keys.forEach(({ key, index }) => {
    if (index > at) parts.push(<Highlight key={`t${at}`} text={text.slice(at, index)} query={query} />)
    parts.push(<ExcerptKey key={`k${index}`} taskKey={key} query={query} />)
    at = index + key.length
  })
  if (at < text.length) parts.push(<Highlight key={`t${at}`} text={text.slice(at)} query={query} />)
  return <>{parts}</>
}

function Meta({ note, scope, now }: { note: NoteSummary; scope: NoteScopeInfo; now: number }) {
  const { done, total } = note.checklist
  if (note.deleted_at) return <span className="truncate">{purgeLabel(note.deleted_at, now)}</span>
  return (
    <>
      <time dateTime={note.updated_at} className="shrink-0 tabular-nums">
        {ageLabel(note.updated_at, now)}
      </time>
      <span className="note-scope min-w-0">
        <ProjectDot projectId={scope.projectId} />
        <span className="truncate">{scope.name}</span>
      </span>
      {total > 0 && (
        <span className="note-progress" title={`${done} of ${total} done`}>
          <ChecklistRing done={done} total={total} />
          <span className="tabular-nums">
            {done}/{total}
          </span>
        </span>
      )}
    </>
  )
}

function closeIfOpen(note: NoteSummary) {
  const current = useStore.getState().selected
  if (current.kind === "notes" && current.noteId === note.id) useStore.getState().selectNotes()
}

function WithMenu({ note, onPurge, children }: { note: NoteSummary; onPurge: (note: NoteSummary) => void; children: React.ReactElement }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger render={children} />
      <ContextMenuContent className="w-52 min-w-52">
        <NoteMenuItems note={note} kit={CONTEXT_KIT} readText={() => readNoteText(note)} onDeleted={() => closeIfOpen(note)} onPurge={onPurge} />
      </ContextMenuContent>
    </ContextMenu>
  )
}

function NoteCardView({ note, scope, tabStop, now, query, onPurge, big }: ItemProps & { big: boolean }) {
  return (
    <WithMenu note={note} onPurge={onPurge}>
      <button
        type="button"
        data-note-card={note.id}
        tabIndex={tabStop ? 0 : -1}
        onClick={() => openNote(note.id)}
        className={cn("note-card", big && "note-card-big")}
        aria-label={noteTitle(note)}
      >
        <NoteThumb note={note} />
        <span className="note-card-label">
          <span className="note-card-title">
            {note.scope === "thread" && <MessageCircleIcon className="note-card-glyph" aria-hidden="true" />}
            <span className="truncate">
              <Highlight text={noteTitle(note)} query={query} />
            </span>
          </span>
          <span className="note-card-meta">
            <Meta note={note} scope={scope} now={now} />
          </span>
        </span>
      </button>
    </WithMenu>
  )
}

function NoteListRowView({ note, scope, tabStop, now, query, snippet, onPurge }: ItemProps) {
  const text = (snippet ?? note.preview).trim()
  const { done, total } = note.checklist
  return (
    <WithMenu note={note} onPurge={onPurge}>
      <button type="button" data-note-card={note.id} tabIndex={tabStop ? 0 : -1} onClick={() => openNote(note.id)} className="note-row">
        <span className="note-row-title">
          {note.scope === "thread" && <MessageCircleIcon className="note-card-glyph" aria-hidden="true" />}
          <span className="truncate">
            <Highlight text={noteTitle(note)} query={query} />
          </span>
        </span>
        <span className="note-row-excerpt">{text ? <Excerpt text={text} query={query} /> : null}</span>
        {note.deleted_at ? (
          <span className="note-row-age">{purgeLabel(note.deleted_at, now)}</span>
        ) : (
          <>
            <span className="note-row-scope note-scope">
              <ProjectDot projectId={scope.projectId} />
              <span className="truncate">{scope.name}</span>
            </span>
            <span className="note-row-progress note-progress">
              {total > 0 && (
                <>
                  <ChecklistRing done={done} total={total} />
                  <span className="tabular-nums">
                    {done}/{total}
                  </span>
                </>
              )}
            </span>
            <time dateTime={note.updated_at} className="note-row-age tabular-nums">
              {ageLabel(note.updated_at, now)}
            </time>
          </>
        )}
      </button>
    </WithMenu>
  )
}

/** Cards re-render when their note, tab stop, search words, scope or the minute changes. */
export const NoteCard = memo(NoteCardView)
export const NoteListRow = memo(NoteListRowView)
