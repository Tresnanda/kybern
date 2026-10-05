// The gallery's controls: the title bar's search field, Display menu and New note
// button; the filter row (All, Global, each project with notes, Threads, then
// Recently deleted); the quiet hint bar; and the empty states.
import { forwardRef, useLayoutEffect, useRef, useState } from "react"

import { Button } from "@/components/kit/button"
import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { Menu, MenuCheckboxItem, MenuGroup, MenuGroupLabel, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "@/components/kit/menu"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import { mod } from "@/lib/format"
import { ChevronDownIcon, CustomizeIcon, MessageCircleIcon, NewThreadIcon, SearchIcon, TrashCanIcon, XIcon } from "@/lib/kit/icons"
import { ProjectDot } from "@/lib/kit/projectDot"
import { observeResizeFrame } from "@/lib/resizeObserver"
import { cn } from "@/lib/utils"
import type { Project, ProjectId } from "@/protocol"
import { createAndOpenNote, currentNewNoteHome } from "@/state/notes"
import { chooseFilter, setNotesDisplay, useNotesDisplay, type NotesLayout } from "@/state/notesDisplay"
import { NOTE_RETENTION_DAYS, type NotesFilter, type NotesGroupBy, type NotesSortBy } from "@/state/notesModel"
import { useStore } from "@/state/store"
import { ChatHeaderButton, ChatHeaderIconButton } from "../chrome"

// ---- title bar ----

export const NotesSearchField = forwardRef<HTMLInputElement, { value: string; onChange: (value: string) => void; onArrowDown: () => void }>(
  function NotesSearchField({ value, onChange, onArrowDown }, ref) {
    return (
      <label className="notes-search">
        <SearchIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <input
          ref={ref}
          type="search"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && value) {
              event.preventDefault()
              onChange("")
            } else if (event.key === "ArrowDown" || (event.key === "Enter" && value.trim())) {
              event.preventDefault()
              onArrowDown()
            }
          }}
          placeholder="Search notes"
          aria-label="Search notes"
          autoComplete="off"
          spellCheck={false}
        />
        {value && (
          <button type="button" className="notes-search-clear" aria-label="Clear search" onClick={() => onChange("")}>
            <XIcon className="size-3" aria-hidden="true" />
          </button>
        )}
      </label>
    )
  },
)

const GROUP_LABEL: Record<NotesGroupBy, string> = { none: "No grouping", date: "Date", project: "Project" }
const SORT_LABEL: Record<NotesSortBy, string> = { edited: "Last edited", created: "Date created", title: "Title" }

export function DisplayMenu() {
  const layout = useNotesDisplay((s) => s.layout)
  const group = useNotesDisplay((s) => s.group)
  const sort = useNotesDisplay((s) => s.sort)
  const hints = useNotesDisplay((s) => s.hints)
  return (
    <Menu>
      <MenuTrigger render={<ChatHeaderButton tone="plain" className="notes-tb-button gap-1.5 px-2" />}>
        <CustomizeIcon className="size-[15px]" aria-hidden="true" />
        Display
      </MenuTrigger>
      <ComposerPickerMenuPopup align="end" side="bottom" sideOffset={6} className="action-menu min-w-52">
        <MenuGroup>
          <MenuGroupLabel>View</MenuGroupLabel>
          <MenuRadioGroup value={layout} onValueChange={(value) => setNotesDisplay({ layout: value as NotesLayout })}>
            <MenuRadioItem value="gallery">Gallery</MenuRadioItem>
            <MenuRadioItem value="list">List</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Group by</MenuGroupLabel>
          <MenuRadioGroup value={group} onValueChange={(value) => setNotesDisplay({ group: value as NotesGroupBy })}>
            {(Object.keys(GROUP_LABEL) as NotesGroupBy[]).map((key) => (
              <MenuRadioItem key={key} value={key}>
                {GROUP_LABEL[key]}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Sort by</MenuGroupLabel>
          <MenuRadioGroup value={sort} onValueChange={(value) => setNotesDisplay({ sort: value as NotesSortBy })}>
            {(Object.keys(SORT_LABEL) as NotesSortBy[]).map((key) => (
              <MenuRadioItem key={key} value={key}>
                {SORT_LABEL[key]}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuCheckboxItem variant="switch" checked={hints} onCheckedChange={(checked) => setNotesDisplay({ hints: checked })}>
          Show keyboard hints
        </MenuCheckboxItem>
      </ComposerPickerMenuPopup>
    </Menu>
  )
}

/** "New note in ade", from the filter in use (else the thread you came from, else Global). */
function newNoteLabel(): string {
  const home = currentNewNoteHome()
  if (home.scope === "global") return "New global note"
  return `New note in ${useStore.getState().projects[home.projectId]?.name ?? "this project"}`
}

export function NewNoteButton() {
  // Re-read on render: the label follows the filter row.
  useNotesDisplay((s) => s.filter)
  const label = newNoteLabel()
  return (
    <Tooltip>
      <TooltipTrigger render={<ChatHeaderIconButton label={label} className="notes-tb-button" onClick={() => void createAndOpenNote()} />}>
        <NewThreadIcon className="size-4" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {label} <span className="notes-tip-key">{mod}N</span>
      </TooltipPopup>
    </Tooltip>
  )
}

// ---- filter row ----

type Chip = { key: string; label: string; filter: NotesFilter; projectId?: string; threads?: boolean }

const sameFilter = (a: NotesFilter, b: NotesFilter) => a.kind === b.kind && (a.kind !== "project" || (b.kind === "project" && a.projectId === b.projectId))

function ChipView({ chip, selected, onClick, measure }: { chip: Chip; selected?: boolean; onClick?: () => void; measure?: boolean }) {
  return (
    <button
      type="button"
      className="notes-chip"
      aria-pressed={measure ? undefined : selected}
      tabIndex={measure ? -1 : undefined}
      data-selected={selected || undefined}
      onClick={onClick}
    >
      {chip.projectId && <ProjectDot projectId={chip.projectId} />}
      {chip.threads && <MessageCircleIcon className="size-[13px] shrink-0 opacity-70" aria-hidden="true" />}
      {chip.filter.kind === "deleted" && <TrashCanIcon className="size-[13px] shrink-0 opacity-70" aria-hidden="true" />}
      <span className="truncate">{chip.label}</span>
    </button>
  )
}

const MORE_WIDTH = 84
const CHIP_GAP = 4

export function FilterRow({ projects, threads, deleted }: { projects: Pick<Project, "id" | "name">[]; threads: number; deleted: number }) {
  const filter = useNotesDisplay((s) => s.filter)
  const rowRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState(Number.POSITIVE_INFINITY)

  const chips: Chip[] = [
    { key: "all", label: "All", filter: { kind: "all" } },
    { key: "global", label: "Global", filter: { kind: "global" } },
    ...projects.map((project): Chip => ({ key: `p:${project.id}`, label: project.name, projectId: project.id, filter: { kind: "project", projectId: project.id as ProjectId } })),
    ...(threads > 0 ? [{ key: "threads", label: "Threads", threads: true, filter: { kind: "threads" } } satisfies Chip] : []),
  ]
  const deletedChip: Chip = { key: "deleted", label: "Recently deleted", filter: { kind: "deleted" } }
  const signature = chips.map((chip) => chip.key + chip.label).join("|")

  // How many chips fit beside the overflow menu; re-measured when the row resizes or the chips change.
  useLayoutEffect(() => {
    const row = rowRef.current
    const ruler = measureRef.current
    if (!row || !ruler) return
    const measure = () => {
      const widths = [...ruler.children].map((child) => (child as HTMLElement).offsetWidth)
      const available = row.clientWidth
      const total = widths.reduce((sum, width) => sum + width + CHIP_GAP, 0)
      if (total <= available) {
        setFit(Number.POSITIVE_INFINITY)
        return
      }
      let used = MORE_WIDTH
      let count = 0
      for (const width of widths) {
        if (used + width + CHIP_GAP > available) break
        used += width + CHIP_GAP
        count++
      }
      setFit(Math.max(2, count))
    }
    measure()
    return observeResizeFrame(row, measure)
  }, [signature])

  const overflowing = fit < chips.length
  let shown = overflowing ? chips.slice(0, fit) : chips
  let hidden = overflowing ? chips.slice(fit) : []
  // The chip in use always stays in view.
  const current = hidden.find((chip) => sameFilter(chip.filter, filter))
  if (current && shown.length > 2) {
    hidden = [shown[shown.length - 1]!, ...hidden.filter((chip) => chip !== current)]
    shown = [...shown.slice(0, -1), current]
  }
  const onDeleted = filter.kind === "deleted"

  return (
    <div className="notes-filters" ref={rowRef} role="group" aria-label="Show notes from">
      <div ref={measureRef} className="notes-filters-ruler" aria-hidden="true">
        {chips.map((chip) => (
          <ChipView key={chip.key} chip={chip} measure />
        ))}
      </div>
      {shown.map((chip) => (
        <ChipView key={chip.key} chip={chip} selected={sameFilter(chip.filter, filter)} onClick={() => chooseFilter(chip.filter)} />
      ))}
      {onDeleted && <ChipView chip={deletedChip} selected onClick={() => chooseFilter(deletedChip.filter)} />}
      {hidden.length > 0 ? (
        <Menu>
          <MenuTrigger render={<button type="button" className="notes-chip" />}>
            More
            <ChevronDownIcon className="size-3 opacity-60" aria-hidden="true" />
          </MenuTrigger>
          <ComposerPickerMenuPopup align="start" side="bottom" sideOffset={6} className="action-menu min-w-48 [--available-height:min(22rem,60vh)]">
            <MenuGroup>
              {hidden.map((chip) => (
                <MenuItem key={chip.key} onClick={() => chooseFilter(chip.filter)}>
                  {chip.projectId ? <ProjectDot projectId={chip.projectId} className="mx-[3.5px]" /> : chip.threads ? <MessageCircleIcon /> : null}
                  <span className="truncate">{chip.label}</span>
                </MenuItem>
              ))}
            </MenuGroup>
            {deleted > 0 && !onDeleted && (
              <>
                <MenuSeparator />
                <MenuGroup>
                  <MenuItem onClick={() => chooseFilter(deletedChip.filter)}>
                    <TrashCanIcon /> Recently deleted
                    <span className="ms-auto ps-4 text-[length:var(--app-font-size-ui-sm,12px)] tabular-nums text-muted-foreground">{deleted}</span>
                  </MenuItem>
                </MenuGroup>
              </>
            )}
          </ComposerPickerMenuPopup>
        </Menu>
      ) : (
        deleted > 0 &&
        !onDeleted && (
          <button type="button" className="notes-chip notes-chip-quiet ms-auto" onClick={() => chooseFilter(deletedChip.filter)}>
            <TrashCanIcon className="size-[13px] shrink-0 opacity-70" aria-hidden="true" />
            Recently deleted
          </button>
        )
      )}
    </div>
  )
}

// ---- hint bar ----

export function HintBar({ layout }: { layout: NotesLayout }) {
  return (
    <div className="notes-hints" aria-hidden="true">
      <span>
        <b>{layout === "list" ? "↑↓" : "←→"}</b>Move
      </span>
      <span>
        <b>↵</b>Open
      </span>
      <span>
        <b>⌫</b>Delete
      </span>
      <span>
        <b>{mod}N</b>New note
      </span>
      <span>
        <b>{mod}F</b>Search
      </span>
      <button type="button" className="notes-hints-hide" tabIndex={-1} onClick={() => setNotesDisplay({ hints: false })}>
        Hide hints
      </button>
    </div>
  )
}

// ---- empty states ----

/** Shown until the first note exists. */
export function FirstNote() {
  return (
    <div className="notes-empty notes-first">
      <h2 className="notes-display">Your notes, across every project</h2>
      <p className="notes-empty-detail">Write things down once. Find them from any thread or project.</p>
      <Button className="mt-2" onClick={() => void createAndOpenNote()}>
        New note
      </Button>
      <ul className="notes-tips">
        <li>
          Type <b>/</b> in a note for headings, checklists and code
        </li>
        <li>
          <b>{mod}⇧N</b> captures a note from anywhere
        </li>
        <li>
          <b>Save to note</b> on any message keeps it here
        </li>
      </ul>
    </div>
  )
}

export function EmptyFilter({ filter, projectName, query, onClearSearch }: { filter: NotesFilter; projectName?: string; query: string; onClearSearch: () => void }) {
  if (query.trim()) {
    return (
      <div className="notes-empty">
        <p className="notes-empty-title">No notes match “{query.trim()}”</p>
        <p className="notes-empty-detail">Search looks at titles and text.</p>
        <Button variant="subtle" size="sm" className="mt-2" onClick={onClearSearch}>
          Clear search
        </Button>
      </div>
    )
  }
  const content: Record<NotesFilter["kind"], { title: string; detail: string; action?: { label: string; run: () => void } }> = {
    all: { title: "No notes yet", detail: "Notes you write show up here.", action: { label: "New note", run: () => void createAndOpenNote() } },
    global: {
      title: "No global notes yet",
      detail: "Global notes belong to no project, so you can find them from every project.",
      action: { label: "New global note", run: () => void createAndOpenNote({ scope: "global" }) },
    },
    project: {
      title: `No notes in ${projectName ?? "this project"}`,
      detail: "Notes for this project show up here, with its threads’ notes.",
      action: filter.kind === "project" ? { label: "New note", run: () => void createAndOpenNote({ scope: "project", projectId: filter.projectId }) } : undefined,
    },
    threads: { title: "No thread notes yet", detail: "Write in a thread’s Notes panel and the note shows up here." },
    deleted: { title: "Nothing in Recently deleted", detail: `Deleted notes stay here for ${NOTE_RETENTION_DAYS} days.` },
  }
  const { title, detail, action } = content[filter.kind]
  return (
    <div className="notes-empty">
      <p className="notes-empty-title">{title}</p>
      <p className="notes-empty-detail">{detail}</p>
      {action && (
        <Button variant="subtle" size="sm" className="mt-2" onClick={action.run}>
          {action.label}
        </Button>
      )}
    </div>
  )
}

export function NotesNotice({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("notes-notice", className)}>{children}</p>
}
