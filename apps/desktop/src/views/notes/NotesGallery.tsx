// The Notes home: a calm gallery of every note on the full workspace card. Filters
// sit in one row of plain text; Pinned notes get larger cards; the rest follow as
// Recent (or grouped by date or project from Display), as cards or compact rows.
// Rows of cards are virtualized, so a thousand notes mount a screenful, and each
// card's miniature is drawn from a cached parse of its Markdown, never an editor.
import { useVirtualizer } from "@tanstack/react-virtual"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"

import { useHotkey, useNow } from "@/lib/hooks"
import { isLaunching } from "@/lib/launch"
import { useGlobalNotesHome } from "@/lib/notesPrefs"
import { observeResizeFrame } from "@/lib/resizeObserver"
import { cn } from "@/lib/utils"
import { isFreeChatProject, type NoteId, type NoteSummary } from "@/protocol"
import { useEnvironments } from "@/state/environments"
import { deleteNote, refreshNotes, searchNoteBodies, startHomeFeed, useAllNotes, useNotes, useNotesReady } from "@/state/notes"
import { useNotesDisplay } from "@/state/notesDisplay"
import { filterChoices, filterNotes, gallerySections, isEmptyThreadNote, NOTE_RETENTION_DAYS, noteMatchesQuery, searchNotes, type GallerySection } from "@/state/notesModel"
import { useStore } from "@/state/store"
import { SurfaceHeader } from "../chrome"
import { NoteCard, NoteListRow, type NoteScopeInfo } from "./NoteCard"
import { PurgeNoteDialog } from "./NoteMenu"
import { DisplayMenu, EmptyFilter, FilterRow, FirstNote, HintBar, NewNoteButton, NotesNotice, NotesSearchField } from "./NotesGalleryChrome"

/** A card is never narrower than this; the column count follows the window. */
const MIN_CARD = 248
const GAP_X = 20
const GAP_Y = 24
const THUMB = 156
const THUMB_BIG = 184
/** Title and meta line under a thumbnail. */
const LABEL = 51
const LIST_ROW = 40
const SEARCH_DELAY_MS = 250

type Item =
  | { kind: "filters"; key: string }
  | { kind: "notice"; key: string; tone: "deleted" | "unreachable" | "results"; count?: number }
  | { kind: "header"; key: string; label: string; first: boolean; list: boolean }
  | { kind: "cards"; key: string; notes: NoteSummary[]; big: boolean; cols: number }
  | { kind: "row"; key: string; note: NoteSummary }
  | { kind: "empty"; key: string }

function estimate(item: Item): number {
  switch (item.kind) {
    case "filters":
      return 48
    case "notice":
      return 46
    case "header":
      return item.first ? 52 : item.list ? 52 : 32
    case "cards":
      return (item.big ? THUMB_BIG : THUMB) + LABEL + GAP_Y
    case "row":
      return LIST_ROW
    case "empty":
      return 320
  }
}

/** Body matches from the daemon, after a short pause in typing. */
function useBodySearch(query: string): Map<NoteId, string> | null {
  const [hits, setHits] = useState<{ query: string; map: Map<NoteId, string> } | null>(null)
  const trimmed = query.trim()
  useEffect(() => {
    if (!trimmed) return
    let live = true
    const timer = setTimeout(() => {
      void searchNoteBodies(trimmed).then((map) => live && setHits({ query: trimmed, map }))
    }, SEARCH_DELAY_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [trimmed])
  return hits && hits.query === trimmed ? hits.map : null
}

/** How wide the gallery is, so the column count can follow it. */
function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    setWidth(element.clientWidth)
    return observeResizeFrame(element, () => setWidth(element.clientWidth))
  }, [ref])
  return width
}

export function NotesGallery() {
  const all = useAllNotes()
  const { loaded, supported, error } = useNotesReady()
  const projects = useStore((s) => s.projects)
  const projectOrder = useStore((s) => s.projectOrder)
  const filter = useNotesDisplay((s) => s.filter)
  const layout = useNotesDisplay((s) => s.layout)
  const group = useNotesDisplay((s) => s.group)
  const sort = useNotesDisplay((s) => s.sort)
  const hints = useNotesDisplay((s) => s.hints)
  const homeStatus = useNotes((s) => s.home.status)
  const preference = useGlobalNotesHome()
  const environment = useEnvironments((s) => s.selectedId)
  const now = useNow(60_000)
  const [query, setQuery] = useState("")
  const bodyHits = useBodySearch(query)
  const searching = query.trim().length > 0
  const [purging, setPurging] = useState<NoteSummary | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const width = useWidth(scrollRef)
  const [enter] = useState(() => !isLaunching())

  useHotkey("mod+f", () => {
    searchRef.current?.focus()
    searchRef.current?.select()
  }, { allowInInput: true })

  const choices = useMemo(() => filterChoices(all, projects, projectOrder), [all, projects, projectOrder])
  const projectName = filter.kind === "project" ? projects[filter.projectId]?.name : undefined

  const visible = useMemo(() => {
    const base = filterNotes(all, filter)
    if (!searching) return { notes: base, snippets: null as Map<NoteId, string | null> | null }
    if (filter.kind === "deleted") return { notes: base.filter((note) => noteMatchesQuery(note, query)), snippets: null }
    const ids = new Set(base.map((note) => note.id))
    const results = searchNotes(all, query, bodyHits).filter((result) => ids.has(result.note.id))
    return { notes: results.map((result) => result.note), snippets: new Map(results.map((result) => [result.note.id, result.snippet])) }
  }, [all, filter, searching, query, bodyHits])

  const sections: GallerySection[] = useMemo(
    () => gallerySections(visible.notes, { group, sort, flat: searching || filter.kind === "deleted", projects, projectOrder, now }),
    [visible.notes, group, sort, searching, filter.kind, projects, projectOrder, now],
  )

  // Where each note lives, once per change of notes or projects; cards compare it by reference.
  const scopes = useMemo(() => {
    const map = new Map<NoteId, NoteScopeInfo>()
    for (const note of visible.notes) {
      const projectId = note.scope !== "global" && note.project_id && !isFreeChatProject(note.project_id) ? note.project_id : null
      const name = note.scope === "global" ? "Global" : projectId ? projects[projectId]?.name ?? note.origin ?? "Project" : note.origin ?? "Chats"
      map.set(note.id, { projectId, name })
    }
    return map
  }, [visible.notes, projects])

  const gutter = width < 720 ? 24 : 40
  const inner = Math.max(0, width - gutter * 2)
  const cols = Math.max(1, Math.min(6, Math.floor((inner + GAP_X) / (MIN_CARD + GAP_X))))
  // Pinned cards are twice as wide while there is room for four or more; narrower, they share the row width.
  const pinCols = cols >= 4 ? Math.round(cols / 2) : cols
  const shared = preference === "shared" && environment !== "local"
  const unreachable = shared && homeStatus === "unreachable" && (filter.kind === "all" || filter.kind === "global")

  const items = useMemo(() => {
    const list: Item[] = [{ kind: "filters", key: "filters" }]
    if (unreachable) list.push({ kind: "notice", key: "unreachable", tone: "unreachable" })
    if (filter.kind === "deleted" && visible.notes.length > 0) list.push({ kind: "notice", key: "deleted", tone: "deleted" })
    if (searching && visible.notes.length > 0) list.push({ kind: "notice", key: "results", tone: "results", count: visible.notes.length })
    if (visible.notes.length === 0) {
      list.push({ kind: "empty", key: "empty" })
      return list
    }
    sections.forEach((section, index) => {
      if (section.label) list.push({ kind: "header", key: `h:${section.key}`, label: section.label, first: index === 0, list: layout === "list" })
      if (layout === "list") {
        for (const note of section.notes) list.push({ kind: "row", key: note.id, note })
        return
      }
      const per = section.pinned ? pinCols : cols
      for (let start = 0; start < section.notes.length; start += per) {
        list.push({ kind: "cards", key: `${section.key}:${start}`, notes: section.notes.slice(start, start + per), big: !!section.pinned, cols: per })
      }
    })
    return list
  }, [sections, layout, cols, pinCols, filter.kind, searching, unreachable, visible.notes.length])

  // Every note in the order the arrows walk it, with the row it sits in.
  const position = useMemo(() => {
    const order: NoteId[] = []
    const at = new Map<NoteId, { order: number; item: number; col: number; cols: number }>()
    items.forEach((item, index) => {
      const notes = item.kind === "cards" ? item.notes : item.kind === "row" ? [item.note] : []
      notes.forEach((note, col) => {
        at.set(note.id, { order: order.length, item: index, col, cols: item.kind === "cards" ? item.cols : 1 })
        order.push(note.id)
      })
    })
    return { order, at }
  }, [items])

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => estimate(items[index]!),
    getItemKey: (index) => items[index]!.key,
    overscan: 3,
  })

  // One card is in the tab order: the last one focused, else the first.
  const [rovingId, setRovingId] = useState<NoteId | undefined>(() => useNotes.getState().lastOpenId)
  const tabStop = rovingId && position.at.has(rovingId) ? rovingId : position.order[0]

  const focusCard = useCallback(
    (id: NoteId) => {
      const at = position.at.get(id)
      if (!at) return
      setRovingId(id)
      const find = () => scrollRef.current?.querySelector<HTMLElement>(`[data-note-card="${CSS.escape(id)}"]`)
      const existing = find()
      if (existing) {
        existing.focus()
        return
      }
      virtualizer.scrollToIndex(at.item, { align: "auto" })
      let tries = 0
      const attempt = () => {
        const element = find()
        if (element) element.focus()
        else if (tries++ < 10) requestAnimationFrame(attempt)
      }
      requestAnimationFrame(attempt)
    },
    [position, virtualizer],
  )

  // Coming back from a note: bring its card into view and give it the focus.
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current || !loaded || items.length < 2) return
    restored.current = true
    const id = useNotes.getState().lastOpenId
    const at = id ? position.at.get(id) : undefined
    if (!id || !at) return
    virtualizer.scrollToIndex(at.item, { align: "center" })
    if (document.activeElement === document.body || !document.activeElement) focusCard(id)
  }, [loaded, items.length, position, virtualizer, focusCard])

  const onKeyDown = (event: React.KeyboardEvent) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>("[data-note-card]")
    const id = card?.dataset.noteCard as NoteId | undefined
    if (!id) return
    const at = position.at.get(id)
    if (!at) return
    const { order } = position
    let target: NoteId | undefined
    switch (event.key) {
      case "ArrowRight":
        target = layout === "list" ? undefined : order[at.order + 1]
        break
      case "ArrowLeft":
        target = layout === "list" ? undefined : order[at.order - 1]
        break
      case "ArrowDown":
      case "ArrowUp": {
        const step = event.key === "ArrowDown" ? 1 : -1
        if (layout === "list") {
          target = order[at.order + step]
          break
        }
        for (let index = at.item + step; index >= 0 && index < items.length; index += step) {
          const row = items[index]!
          if (row.kind !== "cards") continue
          // The card under the same horizontal position, even between rows of different widths.
          const share = (at.col + 0.5) / at.cols
          target = row.notes[Math.min(row.notes.length - 1, Math.floor(share * row.cols))]!.id
          break
        }
        if (!target && step === -1) {
          searchRef.current?.focus()
          event.preventDefault()
          return
        }
        break
      }
      case "Home":
        target = order[0]
        break
      case "End":
        target = order[order.length - 1]
        break
      case "Backspace":
      case "Delete": {
        event.preventDefault()
        const note = all.find((entry) => entry.id === id)
        if (!note) return
        if (note.deleted_at) {
          setPurging(note)
          return
        }
        const next = order[at.order + 1] ?? order[at.order - 1]
        void deleteNote(id).then((done) => {
          if (done && next) focusCard(next)
        })
        return
      }
      default:
        return
    }
    event.preventDefault()
    if (target) focusCard(target)
  }

  const firstRun = loaded && !all.some((note) => !isEmptyThreadNote(note))
  const header = (
    <SurfaceHeader
      dock={false}
      trailing={
        firstRun ? (
          <NewNoteButton />
        ) : (
        <>
          <NotesSearchField ref={searchRef} value={query} onChange={setQuery} onArrowDown={() => position.order[0] && focusCard(position.order[0])} />
          <DisplayMenu />
          <NewNoteButton />
        </>
        )
      }
    >
      <h1 className="notes-tb-title">Notes</h1>
    </SurfaceHeader>
  )

  if (!supported) {
    return (
      <div className="notes-page">
        {header}
        <div className="notes-empty">
          <p className="notes-empty-title">Notes need a newer version</p>
          <p className="notes-empty-detail">Update Kybern on this environment to use notes.</p>
        </div>
      </div>
    )
  }
  if (!loaded && error) {
    return (
      <div className="notes-page">
        {header}
        <div className="notes-empty">
          <p className="notes-empty-title">Couldn’t load notes</p>
          <p className="notes-empty-detail">{error}</p>
          <button type="button" className="notes-text-button mt-2" onClick={refreshNotes}>
            Try again
          </button>
        </div>
      </div>
    )
  }
  if (firstRun) {
    return (
      <div className="notes-page">
        {header}
        <FirstNote />
      </div>
    )
  }

  return (
    <div className={cn("notes-page", enter && "notes-enter")}>
      {header}
      <div ref={scrollRef} className="notes-scroll" onKeyDown={onKeyDown} onFocus={(event) => {
        const id = (event.target as HTMLElement).closest<HTMLElement>("[data-note-card]")?.dataset.noteCard
        if (id && id !== rovingId) setRovingId(id)
      }}>
        {loaded && (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((row) => {
              const item = items[row.index]!
              return (
                <div
                  key={row.key}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  className="notes-vrow"
                  style={{ transform: `translateY(${row.start}px)`, paddingInline: gutter }}
                >
                  {item.kind === "filters" ? (
                    <FilterRow projects={choices.projects} threads={choices.threads} deleted={choices.deleted} />
                  ) : item.kind === "notice" ? (
                    item.tone === "unreachable" ? (
                      <NotesNotice>
                        Global notes live on This Mac. Open Kybern on This Mac to see them.{" "}
                        <button type="button" className="notes-text-button" onClick={() => startHomeFeed()}>
                          Try again
                        </button>
                      </NotesNotice>
                    ) : item.tone === "deleted" ? (
                      <NotesNotice>Notes here are deleted forever after {NOTE_RETENTION_DAYS} days. Right-click a note to restore it.</NotesNotice>
                    ) : (
                      <NotesNotice>
                        {item.count === 1 ? "1 note matches" : `${item.count} notes match`} “{query.trim()}”
                      </NotesNotice>
                    )
                  ) : item.kind === "header" ? (
                    <h2 className={cn("notes-section-label", (item.first || item.list) && "notes-section-label-first")}>{item.label}</h2>
                  ) : item.kind === "cards" ? (
                    <div role="list" className="notes-grid" style={{ gridTemplateColumns: `repeat(${item.cols}, minmax(0, 1fr))` }}>
                      {item.notes.map((note) => (
                        <div role="listitem" key={note.id} className="min-w-0">
                          <NoteCard note={note} big={item.big} scope={scopes.get(note.id)!} tabStop={note.id === tabStop} now={now} query={searching ? query : undefined} onPurge={setPurging} />
                        </div>
                      ))}
                    </div>
                  ) : item.kind === "row" ? (
                    <NoteListRow
                      note={item.note}
                      scope={scopes.get(item.note.id)!}
                      tabStop={item.note.id === tabStop}
                      now={now}
                      query={searching ? query : undefined}
                      snippet={visible.snippets?.get(item.note.id) ?? null}
                      onPurge={setPurging}
                    />
                  ) : (
                    <EmptyFilter filter={filter} projectName={projectName} query={query} onClearSearch={() => setQuery("")} />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
      {hints && <HintBar layout={layout} />}
      <PurgeNoteDialog note={purging} onClose={() => setPurging(null)} />
    </div>
  )
}
