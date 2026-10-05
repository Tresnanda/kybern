// Quick add: a title field in place, at the top of a list group or board column.
// Return adds the task and keeps the field for the next one; ⌘Return adds and opens
// it; Escape (or leaving the empty field) puts the row away.
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { Menu, MenuGroup, MenuGroupLabel, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/kit/menu"
import type { ProjectId } from "@/protocol"
import { errorText } from "@/state/rpc"
import { createTask, openTask, setFocusedTask, stopQuickAdd, type QuickAdd } from "@/state/tasks"
import { useStore } from "@/state/store"
import { ProjectDot } from "@/lib/kit/projectDot"
import { TaskStatusGlyph } from "./TaskGlyphs"

export function QuickAddRow({ request, variant }: { request: QuickAdd; variant: "row" | "card" }) {
  const [title, setTitle] = useState("")
  const [projectId, setProjectId] = useState<ProjectId | null>(request.projectId)
  const [busy, setBusy] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  const projects = useStore((s) => s.projects)
  const list = Object.values(projects).sort((a, b) => a.name.localeCompare(b.name))

  useEffect(() => {
    field.current?.focus()
    field.current?.scrollIntoView({ block: "nearest" })
  }, [])

  const submit = async (open: boolean) => {
    const text = title.trim()
    if (!text || busy) return
    setBusy(true)
    try {
      const task = await createTask({
        scope: projectId ? "project" : "global",
        project_id: projectId,
        title: text,
        status: request.status,
        ...(request.priority ? { priority: request.priority } : {}),
      })
      setTitle("")
      setFocusedTask(task.id)
      if (open) {
        stopQuickAdd()
        openTask(task.id)
      }
    } catch (error) {
      toast.error("Unable to add the task", { description: errorText(error) })
    } finally {
      setBusy(false)
      requestAnimationFrame(() => field.current?.focus())
    }
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      void submit(event.metaKey || event.ctrlKey)
    } else if (event.key === "Escape") {
      event.preventDefault()
      stopQuickAdd()
    }
  }
  const onBlur = () => {
    if (!title.trim() && !menuOpen && !busy) stopQuickAdd()
  }

  const projectButton = (
    <Menu open={menuOpen} onOpenChange={setMenuOpen}>
      <MenuTrigger render={<button type="button" className="tk-btn" aria-label="Project" />}>
        <ProjectDot projectId={projectId} />
        <span className="max-w-32 truncate">{projectId ? projects[projectId]?.name ?? "Project" : "Global"}</span>
      </MenuTrigger>
      <ComposerPickerMenuPopup align="end" side="bottom" className="min-w-48" finalFocus={field}>
        <MenuGroup>
          <MenuGroupLabel>Project</MenuGroupLabel>
          <MenuRadioGroup value={projectId ?? "global"} onValueChange={(value) => setProjectId(value === "global" ? null : (value as ProjectId))}>
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
      <div className="tk-card-quick">
        <textarea
          ref={field}
          rows={2}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
          placeholder="Task title"
          aria-label="New task title"
          disabled={busy}
        />
        <div className="mt-1 flex items-center justify-end">{projectButton}</div>
      </div>
    )
  }
  return (
    <div className="tk-quick">
      <span className="st">
        <TaskStatusGlyph status={request.status} />
      </span>
      <input
        ref={field}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        placeholder="Task title"
        aria-label="New task title"
        disabled={busy}
      />
      {projectButton}
    </div>
  )
}
