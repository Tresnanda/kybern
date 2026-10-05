// The picker behind "Save to note": a small searchable list of notes, with "New note"
// first. One instance serves every message; it opens beside the button that was
// pressed and builds its list only while open.
import { useMemo, useState } from "react"

import { AutocompleteItem } from "@/components/kit/autocomplete"
import { Command, CommandInput, CommandList } from "@/components/kit/command"
import { Popover, PopoverPopup } from "@/components/kit/popover"
import { relativeTime } from "@/lib/format"
import { PlusIcon } from "@/lib/kit/icons"
import { isFreeChatProject, type NoteSummary } from "@/protocol"
import { useAllNotes } from "@/state/notes"
import { ProjectDot } from "@/lib/kit/projectDot"
import { isEmptyThreadNote, noteMatchesQuery, noteTitle } from "@/state/notesModel"
import { closeSaveToNote, saveToExistingNote, saveToNewNote, useSaveToNote, type SaveRequest } from "@/state/saveToNote"
import { useStore } from "@/state/store"
import { NoteGlyph } from "./NoteGlyph"

/** Where a note lives, short: Global, its project, or Chats for a free chat's note. */
function scopeName(note: NoteSummary, projects: ReturnType<typeof useStore.getState>["projects"]): string {
  if (note.scope === "global") return "Global"
  if (!note.project_id || isFreeChatProject(note.project_id)) return note.origin ?? "Chats"
  return projects[note.project_id]?.name ?? note.origin ?? "Project"
}

type Choice = { kind: "new"; id: "new" } | { kind: "note"; id: string; note: NoteSummary }

const VISIBLE_NOTES = 50

export function SaveToNotePicker() {
  const open = useSaveToNote((s) => s.open)
  const request = useSaveToNote((s) => s.request)
  if (!request) return null
  return (
    <Popover open={open} onOpenChange={(next) => { if (!next) closeSaveToNote() }}>
      <PopoverPopup
        anchor={request.anchor}
        side="top"
        align="start"
        sideOffset={8}
        aria-label="Save to note"
        className="w-[min(21rem,calc(100vw-1.5rem))] rounded-2xl **:data-[slot=popover-viewport]:p-0"
      >
        <PickerBody request={request} />
      </PopoverPopup>
    </Popover>
  )
}

function PickerBody({ request }: { request: SaveRequest }) {
  const [query, setQuery] = useState("")
  const all = useAllNotes()
  const projects = useStore((s) => s.projects)
  const threads = useStore.getState().threads
  const thread = threads[request.threadId]
  const newNoteGoes = thread && !isFreeChatProject(thread.project_id) ? projects[thread.project_id]?.name : undefined

  const items = useMemo<Choice[]>(() => {
    const recent = all
      .filter((note) => !note.deleted_at && !isEmptyThreadNote(note) && noteMatchesQuery(note, query))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, VISIBLE_NOTES)
      .map((note): Choice => ({ kind: "note", id: note.id, note }))
    const create: Choice = { kind: "new", id: "new" }
    // With nothing typed, "New note" leads. Once a search is typed, the best match leads so Enter picks it.
    return query.trim() && recent.length > 0 ? [...recent, create] : [create, ...recent]
  }, [all, query])

  return (
    <>
      <div className="save-note-head">
        <p className="save-note-title">Save to note</p>
        <p className="save-note-sub">{request.selection ? "The selected text, as a quote" : "This message, as a quote"}</p>
      </div>
      <Command
        items={items}
        value={query}
        onValueChange={(next) => setQuery(next)}
        filter={null}
        itemToStringValue={(item) => { const choice = item as Choice; return choice.kind === "new" ? "New note" : noteTitle(choice.note) }}
      >
        <CommandInput placeholder="Find a note" size="sm" />
        <CommandList className="max-h-72 not-empty:px-1.5 not-empty:pt-0 not-empty:pb-1.5">
          {(item: Choice) => (
            <AutocompleteItem
              key={item.id}
              value={item}
              onClick={() => {
                closeSaveToNote()
                if (item.kind === "new") void saveToNewNote(request)
                else void saveToExistingNote(request, item.note.id, noteTitle(item.note))
              }}
              className="cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5"
            >
              {item.kind === "new" ? (
                <>
                  <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground"><PlusIcon className="size-[15px]" /></span>
                  <span className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui,13px)] text-foreground">{newNoteGoes ? `New note in ${newNoteGoes}` : "New global note"}</span>
                </>
              ) : (
                <>
                  <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
                    <NoteGlyph note={item.note} className="size-[15px]" />
                  </span>
                  <span className="min-w-24 flex-1 truncate text-[length:var(--app-font-size-ui,13px)] text-foreground">{noteTitle(item.note)}</span>
                  <span className="save-note-meta">
                    {item.note.thread_id === request.threadId ? (
                      <span className="truncate">This thread’s note</span>
                    ) : (
                      <>
                        <ProjectDot projectId={item.note.scope === "global" || !item.note.project_id || isFreeChatProject(item.note.project_id) ? null : item.note.project_id} />
                        <span className="truncate">{scopeName(item.note, projects)}</span>
                      </>
                    )}
                  </span>
                  <span className="w-8 shrink-0 text-end text-[length:var(--app-font-size-ui-sm,12px)] text-[color:var(--n-fg3)] tabular-nums">{relativeTime(item.note.updated_at)}</span>
                </>
              )}
            </AutocompleteItem>
          )}
        </CommandList>
      </Command>
    </>
  )
}
