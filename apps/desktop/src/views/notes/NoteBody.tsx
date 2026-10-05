// The note's body: a Tiptap editor over Markdown. This file is the editor
// chunk; it is loaded only when a note is opened, so launch never pays for it.
import type { Editor } from "@tiptap/core"
import { EditorContent, ReactNodeViewRenderer, useEditor } from "@tiptap/react"
import { useEffect, useLayoutEffect, useMemo, useRef } from "react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { errorText } from "@/state/rpc"
import { createNoteExtensions } from "./editorExtensions"
import type { NoteImageHost } from "./noteImage"
import { NoteImageView } from "./NoteImageView"
import { openNoteLink } from "./noteLinks"
import { tidyMarkdown } from "./tidyMarkdown"
import { FormatBar } from "./FormatBar"
import { isMakingTask, makeTaskFromLine, type NoteTaskContext } from "./noteTaskActions"
import { createSlashController } from "./slashController"
import { SlashMenu } from "./SlashMenu"
import type { TaskLineHost } from "./taskLinks"
import { TaskRefView } from "./TaskRefView"

/** What the editor needs from whoever owns the text: a note's session, or quick capture's draft. */
export interface NoteBodyHost {
  /** The text changed. */
  bodyEdited(): void
  /** The editor lost focus: a good moment to save. */
  flush(): void | Promise<void>
  /** Hands over a reader for the current Markdown, or null when the editor goes away. */
  bindBody(read: (() => string) | null): void
}

export interface NoteBodySnapshot {
  content: { body: string }
  /** The editor replaces its text when this changes. */
  epoch: number
  deleted: boolean
}

/**
 * Show a newer version of the text in place: only the part that differs is
 * replaced, so the caret, the selection and the undo history of everything else
 * stay put (a task link appended to a line, a line ticked elsewhere).
 */
function replaceBody(editor: Editor, markdown: string) {
  let next: ReturnType<Editor["schema"]["nodeFromJSON"]> | null
  try {
    const json = editor.markdown?.parse(markdown)
    next = json ? editor.schema.nodeFromJSON(json) : null
    next?.check()
  } catch {
    next = null
  }
  if (!next || next.childCount === 0) {
    editor.commands.setContent(markdown, { contentType: "markdown", emitUpdate: false })
    return
  }
  const { state } = editor
  // The editor keeps an empty paragraph after a last block that is not one (the
  // trailing node); keep it, or the whole end of the note would count as changed.
  const last = state.doc.lastChild
  if (last?.type.name === "paragraph" && last.childCount === 0 && !(next.lastChild?.type.name === "paragraph" && next.lastChild.childCount === 0)) {
    next = next.copy(next.content.addToEnd(last.type.create()))
  }
  const start = state.doc.content.findDiffStart(next.content)
  if (start == null) return
  const end = state.doc.content.findDiffEnd(next.content)
  if (!end) return
  let { a: endA, b: endB } = end
  // Equal runs at both ends can overlap when text repeats; widen to keep the ranges valid.
  const overlap = start - Math.min(endA, endB)
  if (overlap > 0) {
    endA += overlap
    endB += overlap
  }
  const tr = state.tr.replace(start, endA, next.slice(start, endB))
  editor.view.dispatch(tr.setMeta("addToHistory", false).setMeta("preventUpdate", true))
}

/** "Make task" for the editor's checklist lines, pointed at whichever note the editor shows. */
function createLineHost() {
  let context: NoteTaskContext | null = null
  const host: TaskLineHost = {
    enabled: () => !!context,
    makeTask: (editor, pos) => {
      if (context) void makeTaskFromLine(editor, pos, context)
    },
    busy: isMakingTask,
  }
  return {
    host,
    setContext: (next: NoteTaskContext | null) => {
      context = next
    },
  }
}

/** Where the editor's images go, swapped in place as the note's host changes. */
function createImageSlot() {
  let host: NoteImageHost | null = null
  return {
    get: () => host,
    set: (next: NoteImageHost | null) => {
      host = next
    },
  }
}

/** Markdown with one trailing newline, or nothing for an empty note. */
function readMarkdown(editor: Editor): string {
  const markdown = tidyMarkdown(editor.getMarkdown()).trimEnd()
  return markdown ? `${markdown}\n` : ""
}

export default function NoteBody({
  host,
  snapshot,
  variant,
  onEditor,
  placeholder,
  onBackspaceAtStart,
  tasks,
  images,
  className,
}: {
  host: NoteBodyHost
  snapshot: NoteBodySnapshot
  variant: "page" | "compact"
  /** Hands the editor to the note's title field and to focus requests. */
  onEditor: (editor: Editor | null) => void
  placeholder?: string
  /** Backspace at the start of an empty first line: the title, if there is one, takes the caret. */
  onBackspaceAtStart?: () => void
  /** Where "Make task" puts a task made from a checklist line; null where lines cannot become tasks. */
  tasks?: NoteTaskContext | null
  /** Where pasted and dropped images are kept; null where text only (task descriptions). */
  images?: NoteImageHost | null
  className?: string
}) {
  const slash = useMemo(() => createSlashController(), [])
  const lines = useMemo(() => createLineHost(), [])
  useLayoutEffect(() => lines.setContext(tasks ?? null), [lines, tasks])
  // Read when an image is added or shown, so a note whose home changes keeps one editor.
  const imageSlot = useMemo(() => createImageSlot(), [])
  useLayoutEffect(() => imageSlot.set(images ?? null), [imageSlot, images])
  const extensions = useMemo(
    () =>
      createNoteExtensions(
        slash.render,
        placeholder ?? "Type / for commands",
        { view: ReactNodeViewRenderer(TaskRefView, { as: "span" }), lines: lines.host },
        {
          nodeView: ReactNodeViewRenderer(NoteImageView, { as: "span" }),
          host: imageSlot.get,
          onError: (error) => toast.error("Unable to add the image", { description: errorText(error) }),
        },
      ),
    [slash, placeholder, lines, imageSlot],
  )
  const appliedEpoch = useRef(snapshot.epoch)
  const backspaceRef = useRef(onBackspaceAtStart)
  useEffect(() => {
    backspaceRef.current = onBackspaceAtStart
  })

  const editor = useEditor({
    extensions,
    content: snapshot.content.body,
    contentType: "markdown",
    editable: !snapshot.deleted,
    onUpdate: () => host.bodyEdited(),
    onBlur: () => void host.flush(),
    editorProps: {
      attributes: {
        class: "note-prose outline-none",
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": "Note",
        spellcheck: "true",
      },
      // A plain click on a link places the caret, so a link can be edited like any text.
      // ⌘-click opens it; while the caret is inside one, a small bar offers Open, Edit and Remove.
      handleClick: (_view, _pos, event) => {
        if (!event.metaKey && !event.ctrlKey) return false
        const anchor = (event.target as HTMLElement | null)?.closest("a[href]")
        const href = anchor?.getAttribute("href")
        if (!href) return false
        event.preventDefault()
        openNoteLink(href)
        return true
      },
      handleKeyDown: (view, event) => {
        if (event.key !== "Backspace" || event.isComposing || !backspaceRef.current) return false
        const { selection } = view.state
        const { $from } = selection
        if (!selection.empty || $from.pos !== 1 || $from.parent.type.name !== "paragraph" || $from.parent.content.size > 0) return false
        event.preventDefault()
        backspaceRef.current()
        return true
      },
    },
  })

  useEffect(() => {
    onEditor(editor)
    return () => onEditor(null)
  }, [editor, onEditor])

  // The session reads the Markdown lazily, when it is time to save.
  useEffect(() => {
    if (!editor) return
    host.bindBody(() => readMarkdown(editor))
    return () => host.bindBody(null)
  }, [editor, host])

  // Links open on ⌘-click, so they show the pointing hand only while ⌘ is held.
  useEffect(() => {
    if (!editor) return
    // The editor's DOM exists a moment after the editor does; look it up when a key is pressed.
    const dom = () => (editor.isInitialized && !editor.isDestroyed ? editor.view.dom : null)
    const sync = (event: KeyboardEvent) => dom()?.toggleAttribute("data-open-links", event.metaKey || event.ctrlKey)
    const clear = () => dom()?.removeAttribute("data-open-links")
    window.addEventListener("keydown", sync)
    window.addEventListener("keyup", sync)
    window.addEventListener("blur", clear)
    return () => {
      window.removeEventListener("keydown", sync)
      window.removeEventListener("keyup", sync)
      window.removeEventListener("blur", clear)
    }
  }, [editor])

  // Show a newer version when one is loaded: another device's edit, or the daemon
  // linking a line to a task. Before paint, so typing never lands in between.
  useLayoutEffect(() => {
    if (!editor || snapshot.epoch === appliedEpoch.current) return
    appliedEpoch.current = snapshot.epoch
    const body = snapshot.content.body
    // A microtask still runs before the next input event, and lets the new
    // references' React views render outside this commit.
    queueMicrotask(() => {
      if (!editor.isDestroyed) replaceBody(editor, body)
    })
  }, [editor, snapshot.epoch, snapshot.content.body])

  useEffect(() => {
    editor?.setEditable(!snapshot.deleted)
  }, [editor, snapshot.deleted])

  if (!editor) return null
  return (
    <>
      <EditorContent editor={editor} className={cn("note-editor", variant === "compact" && "note-editor-compact", className)} />
      {/* The page formats from its toolbar; panels and quick capture use the selection bar. */}
      <FormatBar editor={editor} selectionBar={variant === "compact"} />
      <SlashMenu controller={slash} editor={editor} />
    </>
  )
}
