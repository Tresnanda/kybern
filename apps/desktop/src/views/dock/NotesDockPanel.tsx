// The dock's Notes pane: the open thread's note on top, then the project's (or
// Global's) pinned and recent notes as compact rows. A row opens the note on the
// Notes page; "New note" opens quick capture, so writing one never leaves the thread.
import { memo, useMemo } from "react"

import { Button } from "@/components/kit/button"
import { IconButton } from "@/components/kit/icon-button"
import { mod, relativeTime } from "@/lib/format"
import { ArrowUpRightIcon, NoteIcon, PlusIcon } from "@/lib/kit/icons"
import { ChecklistRing } from "@/lib/kit/projectDot"
import type { NoteSummary, ProjectId, ThreadId } from "@/protocol"
import { openNote, refreshNotes, useAllNotes, useNotes, useNotesReady } from "@/state/notes"
import { chooseFilter } from "@/state/notesDisplay"
import { isEmptyThreadNote, noteTitle } from "@/state/notesModel"
import { openQuickNote, useQuickNote } from "@/state/quickNote"
import { useStore } from "@/state/store"
import { ThreadNotePanel } from "../notes/ThreadNotePanel"
import { CreatedByThread } from "../tasks/CreatedBy"
import { DOCK_HEADER_ICON_BUTTON_CLASS } from "../chrome"
import { DockEmpty, DockFooterLink, DockHint, DockScopeHeader, DockSectionLabel } from "./DockParts"
import { DOCK_META_CLASS, DOCK_PINNED_LIMIT, DOCK_ROW_LIMIT, DOCK_TWO_LINE_ROW_CLASS, dockNotes, useDockProjectId, useMinuteNow, useShownOnce } from "./dockModel"

/** Quick capture, filed in the dock's project unless a draft from last time says otherwise. */
function newNote(projectId: ProjectId | null) {
  if (useQuickNote.getState().open) return
  openQuickNote()
  const { title, body } = useQuickNote.getState()
  if (!title && !body) useQuickNote.setState({ home: projectId ? { scope: "project", projectId } : { scope: "global" } })
}

function showAllNotes(projectId: ProjectId | null) {
  const store = useStore.getState()
  store.set({ settingsOpen: false })
  chooseFilter(projectId ? { kind: "project", projectId } : { kind: "global" })
  store.selectNotes()
}

export function NotesDockPanel({ threadId, active }: { threadId: ThreadId | null; active: boolean }) {
  const shown = useShownOnce(active)
  if (!shown) return null
  return <NotesDockContent threadId={threadId} active={active} />
}

const NotesDockContent = memo(function NotesDockContent({ threadId, active }: { threadId: ThreadId | null; active: boolean }) {
  const projectId = useDockProjectId(threadId)
  const projectName = useStore((s) => (projectId ? s.projects[projectId]?.name : undefined))
  const all = useAllNotes()
  const ready = useNotesReady()
  const threadNote = useNotes((s) => {
    if (!threadId) return undefined
    for (const note of Object.values(s.env.notes)) if (note.thread_id === threadId) return note
    return undefined
  })
  const { pinned, recent } = useMemo(() => dockNotes(all, projectId, threadNote?.id ?? null), [all, projectId, threadNote?.id])
  const now = useMinuteNow(active)
  const shownPinned = pinned.slice(0, DOCK_PINNED_LIMIT)
  const shownRecent = recent.slice(0, Math.max(0, DOCK_ROW_LIMIT - shownPinned.length))
  const empty = pinned.length === 0 && recent.length === 0
  const where = projectId ? projectName ?? "this project" : "Global"

  const newNoteButton = (
    <IconButton variant="chrome" size="icon-xs" className={DOCK_HEADER_ICON_BUTTON_CLASS} label="New note" tooltip={`New note (${mod}⇧N)`} tooltipSide="bottom" onClick={() => newNote(projectId)}>
      <PlusIcon />
    </IconButton>
  )

  let lists: React.ReactNode
  if (!ready.supported || (ready.error && !ready.loaded)) {
    lists = threadId ? (
      <DockHint>{ready.error ?? "Unable to load notes."}</DockHint>
    ) : (
      <DockEmpty icon={<NoteIcon className="size-4" />} title="Unable to load notes" body={ready.error ?? "Check the connection and try again."} action={ready.supported ? <Button size="xs" variant="outline" onClick={refreshNotes}>Try again</Button> : undefined} />
    )
  } else if (!ready.loaded) {
    lists = null
  } else if (empty) {
    lists = threadId ? (
      <DockHint>Other notes for {where} appear here.</DockHint>
    ) : (
      <DockEmpty
        icon={<NoteIcon className="size-4" />}
        title="No notes yet"
        body={`Notes for ${where} appear here.`}
        action={<Button size="xs" variant="outline" onClick={() => newNote(projectId)}>New note</Button>}
      />
    )
  } else {
    lists = (
      <>
        {shownPinned.length > 0 && (
          <section aria-label="Pinned notes">
            <DockSectionLabel label="Pinned" />
            <div className="flex flex-col gap-px px-1.5">
              {shownPinned.map((note) => <NoteRow key={note.id} note={note} now={now} />)}
            </div>
          </section>
        )}
        {shownRecent.length > 0 && (
          <section aria-label="Recent notes" className={shownPinned.length > 0 ? "mt-2" : undefined}>
            <DockSectionLabel label="Recent" />
            <div className="flex flex-col gap-px px-1.5">
              {shownRecent.map((note) => <NoteRow key={note.id} note={note} now={now} />)}
            </div>
          </section>
        )}
        <DockFooterLink label="Show all in Notes" onClick={() => showAllNotes(projectId)} />
      </>
    )
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col font-system-ui">
      <DockScopeHeader projectId={projectId} action={newNoteButton} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-1">
        {threadId && (
          <section aria-label="This thread’s note" className="mb-2">
            <DockSectionLabel
              label="This thread"
              trailing={threadNote && !threadNote.deleted_at && !isEmptyThreadNote(threadNote) ? (
                <IconButton variant="ghost" size="icon-xs" className="size-5" label="Open in Notes" tooltip="Open in Notes" onClick={() => openNote(threadNote.id)}>
                  <ArrowUpRightIcon className="size-3.5" />
                </IconButton>
              ) : undefined}
            />
            <ThreadNotePanel key={threadId} threadId={threadId} />
          </section>
        )}
        {lists}
      </div>
    </div>
  )
})

const NoteRow = memo(function NoteRow({ note, now }: { note: NoteSummary; now: number }) {
  const title = noteTitle(note)
  const preview = note.preview.replace(/\s+/g, " ").trim()
  return (
    <button type="button" className={DOCK_TWO_LINE_ROW_CLASS} onClick={() => openNote(note.id)} title={title}>
      <span className="flex w-full min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {note.created_by_thread && <CreatedByThread threadId={note.created_by_thread} variant="glyph" interactive={false} className="text-muted-foreground/55" />}
        {note.checklist.total > 0 && (
          <span className="flex shrink-0 items-center text-muted-foreground/55">
            <ChecklistRing done={note.checklist.done} total={note.checklist.total} />
            <span className="sr-only">{`${note.checklist.done} of ${note.checklist.total} checked`}</span>
          </span>
        )}
        <time dateTime={note.updated_at} className={DOCK_META_CLASS}>{relativeTime(note.updated_at, now)}</time>
      </span>
      {preview && <span className="w-full truncate text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/60">{preview}</span>}
    </button>
  )
})
