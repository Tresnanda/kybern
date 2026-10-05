// The note editor. `<NoteEditor noteId />` opens a note by id; `<NoteEditor threadId />`
// opens a thread's note (created on the first character typed). The page variant is
// the focused document of the Notes page: back arrow and "Notes / title" in the title
// bar, a floating toolbar, the outline in the left margin, a quiet meta line over a
// large title, and a footer strip with linked tasks and the word count. Esc goes back
// to the gallery. The compact variant is just the body and a quiet status line, for
// panels (the thread's Environment panel).
import type { Editor } from "@tiptap/core"
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"

import { Button } from "@/components/kit/button"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import { useNow } from "@/lib/hooks"
import { isLaunching } from "@/lib/launch"
import { ArrowLeftIcon, ArrowUpRightIcon, MessageCircleIcon, PinFilledIcon, PinIcon } from "@/lib/kit/icons"
import { ProjectDot } from "@/lib/kit/projectDot"
import { observeResizeFrame } from "@/lib/resizeObserver"
import { cn } from "@/lib/utils"
import { isFreeChatProject, type NoteId, type NoteSummary, type ThreadId } from "@/protocol"
import { countWords, wordCountLabel } from "@/state/miniMarkdown"
import { clearFocusRequest, fetchNoteImage, noteSourceOf, pinNote, restoreNote, uploadNoteImage, useNotes, useNoteSummary } from "@/state/notes"
import { setNotesDisplay, useNotesDisplay } from "@/state/notesDisplay"
import { editedAgo, noteScopeLabel } from "@/state/notesModel"
import { loadThread } from "@/state/rpc"
import { useStore } from "@/state/store"
import { useTasks } from "@/state/tasks"
import { ChatHeaderIconButton, SurfaceHeader } from "../chrome"
import { NoteFooterTasks } from "./NoteFooterTasks"
import { NoteMenu, NoteScopeMenu, NoteShareMenu, PurgeNoteDialog } from "./NoteMenu"
import { NoteOutline } from "./NoteOutline"
import { useHeadings } from "./outlineHeadings"
import type { NoteImageHost } from "./noteImage"
import type { NoteTaskContext } from "./noteTaskActions"
import { NoteToolbar } from "./NoteToolbar"
import { SaveStatus } from "./SaveStatus"
import { CreatedByThread } from "../tasks/CreatedBy"
import { useNoteSession } from "./useNoteSession"

// The editor itself (Tiptap and its extensions) is its own chunk.
const NoteBody = lazy(() => import("./NoteBody"))

/** The document column. The outline needs this much margin beside it to show its labels. */
const COLUMN = 640
const OUTLINE_LABELS_MIN_MARGIN = 236
const OUTLINE_RAIL_MIN_MARGIN = 72
const WORD_COUNT_DELAY_MS = 400

export interface NoteEditorProps {
  /** Open a note by id... */
  noteId?: NoteId
  /** ...or a thread's note. Exactly one of the two. */
  threadId?: ThreadId
  /** "page": the Notes page. "compact": body and status only, for panels. */
  variant?: "page" | "compact"
  /** Focus the title (page) or the body when the editor appears. */
  autoFocus?: "title" | "body"
  /** Placeholder for an empty body. */
  placeholder?: string
  className?: string
  /** Called after the note was deleted from its menu. */
  onDeleted?: () => void
}

export function NoteEditor(props: NoteEditorProps) {
  // A different note is a different editor: its own session, its own undo history.
  const key = props.noteId ? `note:${props.noteId}` : `thread:${props.threadId}`
  return <NoteEditorInner key={key} {...props} />
}

/** Back to the gallery, which brings this note's card into view. */
function backToGallery() {
  useStore.getState().selectNotes()
}

function NoteEditorInner({ noteId, threadId, variant = "page", autoFocus, placeholder, className, onDeleted }: NoteEditorProps) {
  const { session, snapshot } = useNoteSession({ noteId, threadId })
  const summary = useNoteSummary(snapshot.noteId ?? noteId)
  const [editor, setEditor] = useState<Editor | null>(null)
  const titleRef = useRef<HTMLTextAreaElement>(null)
  const [purging, setPurging] = useState<NoteSummary | null>(null)
  const isThreadNote = threadId !== undefined || summary?.scope === "thread"
  const threadTitle = useStore((s) => (summary?.thread_id ? s.threads[summary.thread_id]?.title : threadId ? s.threads[threadId]?.title : undefined))
  const page = variant === "page"

  // Title text: seeded from the note, replaced when another device's version is loaded.
  const [titleState, setTitleState] = useState({ epoch: snapshot.epoch, value: snapshot.content.title })
  if (titleState.epoch !== snapshot.epoch) setTitleState({ epoch: snapshot.epoch, value: snapshot.content.title })
  const title = titleState.value

  const onEditor = useCallback((next: Editor | null) => setEditor(next), [])
  /** Backspace at the very start of an empty body goes back up to the end of the title. */
  const focusTitleEnd = useCallback(() => {
    const field = titleRef.current
    if (!field) return
    field.focus()
    field.setSelectionRange(field.value.length, field.value.length)
  }, [])

  // Focus on request: a new note focuses its title, Enter in the gallery focuses the body.
  const request = useNotes((s) => s.focusRequest)
  const ready = snapshot.phase === "ready"
  useEffect(() => {
    if (!ready) return
    let target: "title" | "body" | undefined
    let nonce: number | undefined
    if (request && (!request.noteId || request.noteId === snapshot.noteId)) {
      target = request.target
      nonce = request.nonce
    }
    if (!target) return
    if (target === "title" && page && !isThreadNote) {
      titleRef.current?.focus()
    } else if (editor) {
      editor.commands.focus("end")
    } else return
    if (nonce !== undefined) clearFocusRequest(nonce)
  }, [request, ready, snapshot.noteId, editor, page, isThreadNote])

  const autoFocused = useRef(false)
  useEffect(() => {
    if (!autoFocus || autoFocused.current || !ready) return
    if (autoFocus === "title" && page && !isThreadNote) titleRef.current?.focus()
    else if (editor) editor.commands.focus("end")
    else return
    autoFocused.current = true
  }, [autoFocus, ready, editor, page, isThreadNote])

  // Autosize the title as it wraps.
  useLayoutEffect(() => {
    const field = titleRef.current
    if (!field) return
    field.style.height = "0px"
    field.style.height = `${field.scrollHeight}px`
  }, [title, ready])

  const banners = (
    <>
      {snapshot.phase === "failed" && (
        <Banner tone="alert" title="Couldn’t open this note" detail={snapshot.failure ?? undefined}>
          <Button size="xs" variant="subtle" onClick={() => session.reload()}>
            Try again
          </Button>
        </Banner>
      )}
      {snapshot.conflict && (
        <Banner tone="alert" title="This note changed on another device" detail="Keep your version to replace theirs, or use theirs and discard your changes.">
          <Button size="xs" variant="subtle" onClick={() => session.loadTheirs()}>
            Use theirs
          </Button>
          <Button size="xs" onClick={() => session.keepMine()}>
            Keep mine
          </Button>
        </Banner>
      )}
      {snapshot.deleted && summary && (
        <Banner tone="info" title="This note is in Recently deleted" detail="Restore it to edit it again.">
          <Button size="xs" onClick={() => void restoreNote(summary.id)}>
            Restore
          </Button>
        </Banner>
      )}
    </>
  )

  // A saved, editable note can turn its checklist lines into tasks, in its own project or Global.
  const tasksSupported = useTasks((s) => s.supported)
  const taskNoteId = snapshot.noteId
  const taskProjectId = summary?.project_id && !isFreeChatProject(summary.project_id) ? summary.project_id : null
  const taskContext = useMemo<NoteTaskContext | null>(
    () => (taskNoteId && tasksSupported && !snapshot.deleted ? { noteId: taskNoteId, projectId: taskProjectId, saveNow: () => session.saveNow() } : null),
    [taskNoteId, taskProjectId, tasksSupported, snapshot.deleted, session],
  )

  // Pasted images are kept by the daemon that keeps the note, looked up when used.
  const imageHost = useMemo<NoteImageHost>(
    () => ({
      upload: (file) => uploadNoteImage(noteSourceOf(taskNoteId), file),
      load: (id, signal) => fetchNoteImage(noteSourceOf(taskNoteId), id, signal),
    }),
    [taskNoteId],
  )

  const body = ready ? (
    <Suspense fallback={null}>
      <NoteBody
        host={session}
        snapshot={snapshot}
        variant={variant}
        onEditor={onEditor}
        placeholder={placeholder}
        onBackspaceAtStart={page && !isThreadNote ? focusTitleEnd : undefined}
        tasks={taskContext}
        images={imageHost}
      />
    </Suspense>
  ) : null

  if (!page) {
    return (
      <div className={cn("flex min-w-0 flex-col gap-2", className)}>
        {banners}
        {body}
        {/* Says nothing until the first edit. */}
        {ready && <SaveStatus snapshot={snapshot} className="self-end" reserveSpace />}
      </div>
    )
  }

  const shownTitle = isThreadNote ? (threadTitle ?? summary?.title ?? "").trim() || "Untitled" : title.trim() || "Untitled"
  return (
    <NotePage
      className={className}
      summary={summary}
      editor={ready ? editor : null}
      readOnly={snapshot.deleted}
      crumb={shownTitle}
      trailing={
        <>
          {summary && !summary.deleted_at && <PinToggle note={summary} />}
          {summary && <NoteShareMenu note={summary} readText={() => session.currentText()} />}
          {summary && <NoteMenu note={summary} readText={() => session.currentText()} onDeleted={() => onDeleted?.()} onPurge={setPurging} />}
        </>
      }
    >
      <PurgeNoteDialog note={purging} onClose={() => setPurging(null)} onPurged={() => onDeleted?.()} />
      {banners}
      {ready && (
        <>
          <MetaLine summary={summary} threadId={threadId} status={<SaveStatus snapshot={snapshot} className="note-meta-status" idle={summary ? <EditedAt iso={summary.updated_at} /> : undefined} />} />
          {isThreadNote ? (
            <h1 className="note-title">{shownTitle}</h1>
          ) : (
            <textarea
              ref={titleRef}
              rows={1}
              value={title}
              readOnly={snapshot.deleted}
              aria-label="Title"
              placeholder="Untitled"
              maxLength={300}
              spellCheck
              onChange={(event) => {
                // A title is one line: line breaks from pasted text become spaces.
                const value = event.target.value.replace(/\s*\n\s*/g, " ")
                setTitleState({ epoch: snapshot.epoch, value })
                session.setTitle(value)
              }}
              onBlur={() => void session.flush()}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return
                const field = event.currentTarget
                const atEnd = field.selectionStart === field.value.length && field.selectionEnd === field.value.length
                if ((event.key === "Enter" && !event.shiftKey) || (event.key === "ArrowDown" && atEnd && !event.shiftKey)) {
                  event.preventDefault()
                  editor?.commands.focus("start")
                }
              }}
              className="note-title note-title-field"
            />
          )}
          {body}
          {/* The blank space under the text is part of the page: click it to keep writing. */}
          <div className="min-h-24 flex-1 cursor-text" onMouseDown={(event) => { event.preventDefault(); editor?.commands.focus("end") }} aria-hidden="true" />
        </>
      )}
    </NotePage>
  )
}

/** The focused document's frame: title bar, toolbar, outline, scrolling column, footer strip. */
function NotePage({
  summary,
  editor,
  readOnly,
  crumb,
  trailing,
  className,
  children,
}: {
  summary: NoteSummary | null
  editor: Editor | null
  readOnly: boolean
  crumb: string
  trailing: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const [margin, setMargin] = useState(0)
  const outlineOpen = useNotesDisplay((s) => s.outline)
  const headings = useHeadings(editor)
  const { words, referenced } = useDocumentStats(editor)
  const [enter] = useState(() => !isLaunching())

  useLayoutEffect(() => {
    if (!scroller) return
    const measure = () => setMargin((scroller.clientWidth - Math.min(COLUMN, scroller.clientWidth)) / 2)
    measure()
    return observeResizeFrame(scroller, measure)
  }, [scroller])

  const hasOutline = headings.length >= 2 && margin >= OUTLINE_RAIL_MIN_MARGIN
  const labelsFit = margin >= OUTLINE_LABELS_MIN_MARGIN

  return (
    <div
      className={cn("notes-page note-doc-page", enter && "notes-enter", className)}
      onKeyDown={(event) => {
        // Esc leaves the note, unless something inside (the slash list, the link field) used it.
        // Menus and dialogs render in portals; their Esc only closes them.
        if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return
        if (!event.currentTarget.contains(event.target as Node)) return
        event.preventDefault()
        backToGallery()
      }}
    >
      <SurfaceHeader dock={false} trailing={trailing}>
        <nav className="note-crumbs" aria-label="Breadcrumb">
          <Tooltip>
            <TooltipTrigger render={<ChatHeaderIconButton label="Back to Notes" className="-ms-2" onClick={backToGallery} />}>
              <ArrowLeftIcon className="size-4" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              Back to Notes <span className="notes-tip-key">Esc</span>
            </TooltipPopup>
          </Tooltip>
          <button type="button" className="note-crumb-root" onClick={backToGallery}>
            Notes
          </button>
          <span className="note-crumb-sep" aria-hidden="true">
            /
          </span>
          <span className="note-crumb-title" aria-current="page">
            {crumb}
          </span>
        </nav>
      </SurfaceHeader>
      <div className="note-doc-main">
        {editor && !readOnly && <NoteToolbar editor={editor} outline={hasOutline ? outlineOpen : null} onToggleOutline={() => setNotesDisplay({ outline: !outlineOpen })} />}
        {editor && hasOutline && <NoteOutline editor={editor} headings={headings} scroller={scroller} open={outlineOpen && labelsFit} />}
        <div ref={setScroller} className="note-doc-scroll">
          <article className={cn("note-doc", readOnly && "note-doc-readonly")} data-note-id={summary?.id}>
            {children}
          </article>
        </div>
      </div>
      <footer className="note-doc-footer">
        <NoteFooterTasks noteId={summary?.id ?? null} referenced={referenced} />
        <span className="note-footer-count tabular-nums">{wordCountLabel(words)}</span>
      </footer>
    </div>
  )
}

const NO_REFERENCES: ReadonlySet<string> = new Set()

/** Words in the document and the tasks it references, read again a moment after typing pauses. */
function useDocumentStats(editor: Editor | null): { words: number; referenced: ReadonlySet<string> } {
  const [words, setWords] = useState(0)
  const [referenced, setReferenced] = useState(NO_REFERENCES)
  useEffect(() => {
    if (!editor) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const count = () => {
      if (editor.isDestroyed) return
      const { doc } = editor.state
      setWords(countWords(doc.textBetween(0, doc.content.size, " ", " ")))
      const ids = new Set<string>()
      doc.descendants((node) => {
        if (node.type.name === "taskRef" && node.attrs.id) ids.add(node.attrs.id as string)
        return node.isBlock
      })
      // A new set only when the references changed, so the footer does not recompute on every pause.
      setReferenced((current) => (ids.size === current.size && [...ids].every((id) => current.has(id)) ? current : ids.size ? ids : NO_REFERENCES))
    }
    count()
    const onUpdate = () => {
      clearTimeout(timer)
      timer = setTimeout(count, WORD_COUNT_DELAY_MS)
    }
    editor.on("update", onUpdate)
    return () => {
      clearTimeout(timer)
      editor.off("update", onUpdate)
    }
  }, [editor])
  return { words, referenced }
}

/** "● ade · Pinned · Edited 2 min ago", or "Thread note · ● ade · Edited 3 hours ago … Open thread". */
function MetaLine({ summary, threadId, status }: { summary: NoteSummary | null; threadId?: ThreadId; status: React.ReactNode }) {
  const projects = useStore((s) => s.projects)
  const threads = useStore((s) => s.threads)
  if (!summary) return <div className="note-meta">{status}</div>
  const dot = <span className="note-meta-dot" aria-hidden="true">·</span>
  const thread = summary.thread_id ?? threadId
  if (summary.scope === "thread" && thread) {
    // The title is the thread's title, so the line says what kind of note this is and where, not the name again.
    const exists = !!threads[thread]
    const projectId = summary.project_id && !isFreeChatProject(summary.project_id) ? summary.project_id : null
    const project = projectId ? projects[projectId]?.name : undefined
    return (
      <div className="note-meta">
        <MessageCircleIcon className="size-[13px] shrink-0" aria-hidden="true" />
        <span>Thread note</span>
        {(project || summary.origin) && (
          <>
            {dot}
            <span className="note-meta-place">
              <ProjectDot projectId={projectId} />
              <span className="truncate">{project ?? summary.origin}</span>
            </span>
          </>
        )}
        {dot}
        {status}
        {exists && (
          <button type="button" className="note-meta-open" onClick={() => openThread(thread)}>
            Open thread
            <ArrowUpRightIcon className="size-3" aria-hidden="true" />
          </button>
        )}
      </div>
    )
  }
  const label = noteScopeLabel(summary, projects, threads)
  return (
    <div className="note-meta">
      {summary.deleted_at ? <span className="truncate">{label}</span> : <NoteScopeMenu note={summary} label={label} />}
      {summary.pinned && !summary.deleted_at && (
        <>
          {dot}
          <span>Pinned</span>
        </>
      )}
      {summary.created_by_thread && (
        <>
          {dot}
          <CreatedByThread threadId={summary.created_by_thread} className="note-meta-from" />
        </>
      )}
      {dot}
      {status}
    </div>
  )
}

function Banner({ tone, title, detail, children }: { tone: "alert" | "info"; title: string; detail?: string; children?: React.ReactNode }) {
  return (
    <div role={tone === "alert" ? "alert" : "status"} className="note-banner" data-tone={tone}>
      <div className="min-w-0 flex-1 basis-48">
        <p className="note-banner-title">{title}</p>
        {detail && <p className="note-banner-detail">{detail}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

/** Open the chat a thread note belongs to. */
function openThread(threadId: ThreadId) {
  useStore.getState().selectThread(threadId)
  void loadThread(threadId)
}

function PinToggle({ note }: { note: NoteSummary }) {
  const label = note.pinned ? "Unpin" : "Pin to top"
  return (
    <Tooltip>
      <TooltipTrigger
        render={<ChatHeaderIconButton label={label} aria-pressed={note.pinned} onClick={() => void pinNote(note.id, !note.pinned)} />}
      >
        {note.pinned ? <PinFilledIcon className="size-4" /> : <PinIcon className="size-4" />}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  )
}

/** "Edited 3 min ago", kept current as time passes. */
function EditedAt({ iso }: { iso: string }) {
  const now = useNow(60_000)
  return <>{editedAgo(iso, now)}</>
}
