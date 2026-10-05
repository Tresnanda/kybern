// Quick add: a title field in place, at the top of a list group or board column.
// Return adds the task and keeps the field for the next one; ⌘Return adds and opens
// it. A typed title is never lost: clicking away, another "+", switching between list
// and board or to another view, and leaving Tasks all add it. Escape discards it, and
// leaving an empty field puts the row away.
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { Menu, MenuGroup, MenuGroupLabel, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/kit/menu"
import type { ProjectId } from "@/protocol"
import { errorText } from "@/state/rpc"
import { createTask, openTask, setFocusedTask, stopQuickAdd, useTasks, type QuickAdd } from "@/state/tasks"
import { useStore } from "@/state/store"
import { ProjectDot } from "@/lib/kit/projectDot"
import { TaskStatusGlyph } from "./TaskGlyphs"

function taskParams(request: QuickAdd, title: string, projectId: ProjectId | null) {
  return {
    scope: projectId ? ("project" as const) : ("global" as const),
    project_id: projectId,
    title,
    status: request.status,
    ...(request.priority ? { priority: request.priority } : {}),
  }
}

/** Adds a title left behind in a row that is going away; the title stays in the error so it can be typed again. */
function addLeftBehind(request: QuickAdd, title: string, projectId: ProjectId | null) {
  createTask(taskParams(request, title, projectId)).catch((error) => toast.error(`Unable to add “${title}”`, { description: errorText(error) }))
}

/** Puts this row away, unless another "+" already replaced it. */
function closeRow(request: QuickAdd) {
  if (useTasks.getState().quickAdd?.nonce === request.nonce) stopQuickAdd()
}

export function QuickAddRow({ request, variant }: { request: QuickAdd; variant: "row" | "card" }) {
  const [title, setTitle] = useState("")
  const [projectId, setProjectId] = useState<ProjectId | null>(request.projectId)
  const [busy, setBusy] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  const row = useRef<HTMLDivElement>(null)
  const projects = useStore((s) => s.projects)
  const list = Object.values(projects).sort((a, b) => a.name.localeCompare(b.name))
  const view = useTasks((s) => s.prefs.view)
  const filter = useTasks((s) => s.prefs.filter)

  // Blur, menu and unmount handlers read these, never a render's stale copy. A title
  // leaves `draft` the moment it is being added, so it is only ever added once.
  const draft = useRef({ title: "", projectId: request.projectId })
  const submitting = useRef(false)
  // Focus or a press went elsewhere while a title was being added.
  const leftDuringSave = useRef(false)
  const menu = useRef(false)
  const pressing = useRef(false)
  const [owner] = useState(() => useTasks.getState().ownerKey)

  const changeTitle = (value: string) => {
    draft.current.title = value
    setTitle(value)
  }
  const changeProject = (value: ProjectId | null) => {
    draft.current.projectId = value
    setProjectId(value)
  }
  const takeTitle = (): string => {
    const text = draft.current.title.trim()
    draft.current.title = ""
    return text
  }
  /** Adds what was typed, if anything, and puts the row away. */
  const settle = () => {
    const text = takeTitle()
    if (text) addLeftBehind(request, text, draft.current.projectId)
    closeRow(request)
  }
  const settleRef = useRef(settle)
  useEffect(() => {
    settleRef.current = settle
  })

  useEffect(() => {
    field.current?.focus()
    field.current?.scrollIntoView({ block: "nearest" })
    const state = draft.current
    return () => {
      // Leaving Tasks, switching list and board, or another "+": the title is added, in
      // the environment it was typed for.
      const text = state.title.trim()
      if (!text) return
      state.title = ""
      if (useTasks.getState().ownerKey !== owner) return
      addLeftBehind(request, text, state.projectId)
      closeRow(request)
    }
  }, [owner, request])

  // Another view in the panel: the row belonged to the one being left.
  const scope = useRef({ view, filter })
  useEffect(() => {
    if (scope.current.view === view && scope.current.filter === filter) return
    scope.current = { view, filter }
    settleRef.current()
  }, [view, filter])

  const submit = async (open: boolean) => {
    if (submitting.current) return
    const text = takeTitle()
    if (!text) return
    submitting.current = true
    leftDuringSave.current = false
    setBusy(true)
    const notePress = (event: PointerEvent) => {
      if (!(event.target instanceof Node && row.current?.contains(event.target))) leftDuringSave.current = true
    }
    window.addEventListener("pointerdown", notePress, true)
    let task: Awaited<ReturnType<typeof createTask>> | null = null
    let failure: unknown = null
    try {
      task = await createTask(taskParams(request, text, draft.current.projectId))
    } catch (error) {
      failure = error
    }
    window.removeEventListener("pointerdown", notePress, true)
    submitting.current = false
    // Gone (another "+", leaving Tasks) or the user moved on while it saved. The disabled
    // field drops focus to the page itself, which does not count as leaving.
    const node = row.current
    const active = document.activeElement
    const left = !node || leftDuringSave.current || (!!active && active !== document.body && !node.contains(active))
    if (failure) {
      if (left) {
        toast.error(`Unable to add “${text}”`, { description: errorText(failure) })
      } else {
        // The title is still in the field; it counts as typed again.
        draft.current.title = text
        toast.error("Unable to add the task", { description: errorText(failure) })
      }
    }
    if (!node) return
    setBusy(false)
    if (task) {
      setTitle("")
      setFocusedTask(task.id)
      if (open) {
        stopQuickAdd()
        openTask(task.id)
        return
      }
    }
    // What a blur during the save would have done: add anything typed and put the row away.
    if (left) settleRef.current()
    else requestAnimationFrame(() => field.current?.focus())
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      void submit(event.metaKey || event.ctrlKey)
    } else if (event.key === "Escape") {
      event.preventDefault()
      draft.current.title = ""
      stopQuickAdd()
    }
  }

  // Focus leaving the row (the field or its project button) adds what was typed.
  const onBlur = (event: React.FocusEvent) => {
    // The window lost focus to another app; the row still has it when the window returns.
    if (!document.hasFocus() || document.activeElement === event.target) return
    // Adding (the field is disabled meanwhile): settled once the task is in, if focus left the row.
    if (submitting.current) {
      if (event.relatedTarget instanceof Node && !row.current?.contains(event.relatedTarget)) leftDuringSave.current = true
      return
    }
    // Choosing a project, or a press elsewhere in the row.
    if (menu.current || pressing.current) return
    if (event.relatedTarget instanceof Node && row.current?.contains(event.relatedTarget)) return
    settle()
  }

  // A press on the row's own controls keeps it open, and the caret returns to the field after.
  const onPointerDown = () => {
    pressing.current = true
    window.addEventListener(
      "pointerup",
      () =>
        setTimeout(() => {
          pressing.current = false
          const node = row.current
          if (node && !menu.current && !node.contains(document.activeElement)) field.current?.focus()
        }),
      { once: true, capture: true },
    )
  }

  const projectButton = (
    <Menu
      open={menuOpen}
      onOpenChange={(open, details) => {
        menu.current = open
        setMenuOpen(open)
        // Clicking away from the menu clicks away from the row, unless it lands back in the row.
        const target = details.event?.target
        if (!open && details.reason === "outside-press" && !(target instanceof Node && row.current?.contains(target))) settle()
      }}
    >
      <MenuTrigger render={<button type="button" className="tk-btn" aria-label="Project" />}>
        <ProjectDot projectId={projectId} />
        <span className="max-w-32 truncate">{projectId ? projects[projectId]?.name ?? "Project" : "Global"}</span>
      </MenuTrigger>
      <ComposerPickerMenuPopup align="end" side="bottom" className="min-w-48" finalFocus={field}>
        <MenuGroup>
          <MenuGroupLabel>Project</MenuGroupLabel>
          <MenuRadioGroup value={projectId ?? "global"} onValueChange={(value) => changeProject(value === "global" ? null : (value as ProjectId))}>
            <MenuRadioItem closeOnClick value="global">
              <ProjectDot projectId={null} />
              Global
            </MenuRadioItem>
            {list.map((project) => (
              <MenuRadioItem closeOnClick key={project.id} value={project.id}>
                <ProjectDot projectId={project.id} />
                <span className="min-w-0 truncate">{project.name}</span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  )

  if (variant === "card") {
    return (
      <div ref={row} className="tk-card-quick" onPointerDownCapture={onPointerDown} onBlur={onBlur}>
        <textarea
          ref={field}
          rows={2}
          value={title}
          onChange={(event) => changeTitle(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Task title"
          aria-label="New task title"
          disabled={busy}
        />
        <div className="mt-1 flex items-center justify-end">{projectButton}</div>
      </div>
    )
  }
  return (
    <div ref={row} className="tk-quick" onPointerDownCapture={onPointerDown} onBlur={onBlur}>
      <span className="st">
        <TaskStatusGlyph status={request.status} />
      </span>
      <input
        ref={field}
        value={title}
        onChange={(event) => changeTitle(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Task title"
        aria-label="New task title"
        disabled={busy}
      />
      {projectButton}
    </div>
  )
}
