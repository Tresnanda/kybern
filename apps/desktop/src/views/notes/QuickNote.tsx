// Quick capture (⌘⇧N): a small floating panel near the top of the window for writing
// a note without leaving the thread you are in. Esc or a click outside saves and
// closes; an empty panel creates nothing.
import type { Editor } from "@tiptap/core"
import { lazy, Suspense, useCallback, useMemo, useRef, useState } from "react"

import { Button } from "@/components/kit/button"
import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { CommandDialog, CommandDialogPopup } from "@/components/kit/command"
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuTrigger } from "@/components/kit/menu"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import { mod } from "@/lib/format"
import { CheckIcon, ChevronDownIcon } from "@/lib/kit/icons"
import { ProjectDot } from "@/lib/kit/projectDot"
import { FREE_CHAT_PROJECT_ID } from "@/protocol"
import { closeQuickNote, setQuickNote, useQuickNote } from "@/state/quickNote"
import { orderProjects } from "@/state/sidebarOrganize"
import { useStore } from "@/state/store"
import type { NoteBodyHost, NoteBodySnapshot } from "./NoteBody"

// The same editor as the Notes page (slash menu, format bar, checklists), loaded when the panel first opens.
const NoteBody = lazy(() => import("./NoteBody"))

export function QuickNote() {
  const open = useQuickNote((s) => s.open)
  return (
    <CommandDialog
      open={open}
      onOpenChange={(next, details) => {
        if (next) return
        // The "/" menu floats outside the panel; choosing from it is not a click outside.
        const target = details?.event?.target
        if (details?.reason === "outside-press" && target instanceof Element && target.closest("[data-note-popover]")) return
        void closeQuickNote(true)
      }}
    >
      <CommandDialogPopup className="max-h-none max-w-xl sm:mb-[20vh]" aria-label="Capture note">
        <QuickNoteForm />
      </CommandDialogPopup>
    </CommandDialog>
  )
}

function QuickNoteForm() {
  const title = useQuickNote((s) => s.title)
  const [editor, setEditor] = useState<Editor | null>(null)
  const reader = useRef<(() => string) | null>(null)

  // The panel's text lives in the quick-note store (and its localStorage draft), not in the editor.
  const host = useMemo<NoteBodyHost>(
    () => ({
      bodyEdited: () => {
        const read = reader.current
        if (read) setQuickNote({ body: read() })
      },
      flush: () => {},
      bindBody: (read) => {
        reader.current = read
      },
    }),
    [],
  )
  // What the draft held when the panel opened; the editor owns the text from there.
  const [snapshot] = useState<NoteBodySnapshot>(() => ({ content: { body: useQuickNote.getState().body }, epoch: 0, deleted: false }))
  const onEditor = useCallback((next: Editor | null) => setEditor(next), [])

  return (
    <div
      className="quick-note"
      // Before the editor sees it: ⌘↵ saves here, it does not add a line break.
      onKeyDownCapture={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          event.stopPropagation()
          void closeQuickNote(true)
        }
      }}
    >
      <div className="quick-note-scope">
        <span>New note in</span>
        <ScopeChip />
      </div>
      <input
        autoFocus
        aria-label="Title"
        placeholder="Untitled"
        maxLength={300}
        value={title}
        onChange={(event) => setQuickNote({ title: event.target.value.replace(/\s*\n\s*/g, " ") })}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.shiftKey) return
          const field = event.currentTarget
          const atEnd = field.selectionStart === field.value.length && field.selectionEnd === field.value.length
          if (event.key === "Enter" || (event.key === "ArrowDown" && atEnd)) {
            event.preventDefault()
            editor?.commands.focus("start")
          }
        }}
        className="quick-note-title"
      />
      <Suspense fallback={<div className="min-h-24" aria-hidden="true" />}>
        <NoteBody host={host} snapshot={snapshot} variant="compact" onEditor={onEditor} placeholder="Write something. Type / for formatting" className="quick-note-editor" />
      </Suspense>
      <div className="quick-note-foot">
        <p className="quick-note-hint">
          <b>Esc</b>saves and closes
        </p>
        <Button size="sm" variant="ghost" onClick={() => void closeQuickNote(false)}>
          Discard
        </Button>
        <Tooltip>
          <TooltipTrigger render={<Button size="sm" onClick={() => void closeQuickNote(true)} />}>Save note</TooltipTrigger>
          <TooltipPopup side="bottom">
            Save note <span className="notes-tip-key">{mod}↵</span>
          </TooltipPopup>
        </Tooltip>
      </div>
    </div>
  )
}

/** Where the note will live: Global or one project. Starts from what is on screen. */
function ScopeChip() {
  const home = useQuickNote((s) => s.home)
  const projects = useStore((s) => s.projects)
  const projectOrder = useStore((s) => s.projectOrder)
  const list = useMemo(
    () => orderProjects(Object.values(projects), projectOrder).filter((project) => project.id !== FREE_CHAT_PROJECT_ID),
    [projects, projectOrder],
  )
  const project = home.scope === "project" ? projects[home.projectId] : undefined
  return (
    <Menu>
      <MenuTrigger render={<button type="button" className="note-meta-scope" aria-label={`Save to ${project?.name ?? "Global"}. Change`} />}>
        <ProjectDot projectId={project ? project.id : null} />
        <span className="truncate">{project?.name ?? "Global"}</span>
        <ChevronDownIcon className="note-meta-chevron" aria-hidden="true" />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="start" side="bottom" sideOffset={6} className="min-w-48 [--available-height:min(20rem,55vh)]">
        <MenuGroup>
          <MenuGroupLabel>Save to</MenuGroupLabel>
          <MenuItem onClick={() => setQuickNote({ home: { scope: "global" } })}>
            <ProjectDot projectId={null} className="mx-[3.5px]" /> Global
            {home.scope === "global" && <CheckIcon className="ms-auto" />}
          </MenuItem>
          {list.map((entry) => (
            <MenuItem key={entry.id} onClick={() => setQuickNote({ home: { scope: "project", projectId: entry.id } })}>
              <ProjectDot projectId={entry.id} className="mx-[3.5px]" /> <span className="truncate">{entry.name}</span>
              {home.scope === "project" && home.projectId === entry.id && <CheckIcon className="ms-auto" />}
            </MenuItem>
          ))}
        </MenuGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  )
}
