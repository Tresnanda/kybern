// The Coordinator's "Project" dock tab: the project's brief (edited in place, created
// on the first character typed), its setup note, its memory notes, and the switch that
// gives every new thread in the project the brief, then the project's Coordinator settings
// (ProjectCoordinatorSection). RightPanel mounts this only for the
// project's Coordinator. Rows and copy are shared with the Notes pane and with mobile.
import { memo, useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/kit/button"
import { Switch } from "@/components/kit/switch"
import { cn } from "@/lib/utils"
import type { NoteSummary, ProjectId, ThreadId } from "@/protocol"
import { refreshNotes, useAllNotes, useNotesReady } from "@/state/notes"
import { errorText, rpc } from "@/state/rpc"
import { useStore } from "@/state/store"
import { PROJECT_SPACE_COPY, projectSpaceNotes } from "../../../../../packages/kybern-client/src/projectSpace"
import { NoteEditor } from "../notes/NoteEditor"
import { DockFooterLink, DockHint, DockScopeHeader, DockSectionLabel } from "./DockParts"
import { DOCK_ROW_LIMIT, showAllNotes, useMinuteNow, useShownOnce } from "./dockModel"
import { NoteRow } from "./NotesDockPanel"
import { ProjectCoordinatorSection } from "./ProjectCoordinatorSection"

/** The quiet text action at the end of a section label ("Edit", "Done"). */
const SECTION_ACTION_CLASS =
  "press flex h-5 items-center rounded-md px-1.5 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/70 outline-hidden transition-colors hover:bg-[var(--sidebar-accent)] hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"

export function ProjectDockPanel({ threadId, projectId, active }: { threadId: ThreadId; projectId: ProjectId; active: boolean }) {
  const shown = useShownOnce(active)
  if (!shown) return null
  return <ProjectDockContent threadId={threadId} projectId={projectId} active={active} />
}

const ProjectDockContent = memo(function ProjectDockContent({ threadId, projectId, active }: { threadId: ThreadId; projectId: ProjectId; active: boolean }) {
  const all = useAllNotes()
  const ready = useNotesReady()
  const { brief, setup, memory } = useMemo(() => projectSpaceNotes(all, projectId), [all, projectId])
  const now = useMinuteNow(active)
  const shownMemory = memory.slice(0, DOCK_ROW_LIMIT)

  let sections: React.ReactNode
  if (!ready.supported || (ready.error && !ready.loaded)) {
    sections = (
      <div className="flex flex-col items-start gap-2 pb-2">
        <DockHint>{ready.error ?? "This environment needs an update to use notes."}</DockHint>
        {ready.supported && <Button size="xs" variant="outline" className="mx-3.5" onClick={refreshNotes}>Try again</Button>}
      </div>
    )
  } else if (!ready.loaded) {
    sections = null
  } else {
    sections = (
      <>
        <BriefSection projectId={projectId} brief={brief} />
        <section aria-label="Setup" className="mt-2">
          <DockSectionLabel label="Setup" />
          {setup ? (
            <div className="flex flex-col gap-px px-1.5">
              <NoteRow note={setup} now={now} />
            </div>
          ) : (
            <DockHint>{PROJECT_SPACE_COPY.setupEmpty}</DockHint>
          )}
        </section>
        <section aria-label="Memory" className="mt-2">
          <DockSectionLabel label="Memory" count={memory.length > 0 ? memory.length : undefined} />
          {memory.length > 0 ? (
            <div className="flex flex-col gap-px px-1.5">
              {shownMemory.map((note) => <NoteRow key={note.id} note={note} now={now} />)}
            </div>
          ) : (
            <DockHint>{PROJECT_SPACE_COPY.memoryEmpty}</DockHint>
          )}
        </section>
      </>
    )
  }

  return (
    <div data-project-panel={projectId} className="flex h-full min-h-0 w-full min-w-0 flex-col font-system-ui">
      <DockScopeHeader projectId={projectId} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-1">
        {sections}
        <ProjectCoordinatorSection projectId={projectId} threadId={threadId} />
        {/* The switch and the way out sit at the bottom while the lists are short. */}
        <div className="min-h-3 flex-1" aria-hidden="true" />
        <BriefSwitch projectId={projectId} />
        <DockFooterLink label="Show all in Notes" onClick={() => showAllNotes(projectId)} />
      </div>
    </div>
  )
})

/**
 * The brief: its text, clamped, until the user edits it; then the compact note editor
 * in the same place. The first character typed creates the brief note.
 */
function BriefSection({ projectId, brief }: { projectId: ProjectId; brief: NoteSummary | null }) {
  const [editing, setEditing] = useState(false)
  const footId = useId()
  const text = brief?.preview.replace(/\n{3,}/g, "\n\n").trim() ?? ""
  return (
    <section aria-label="Brief">
      <DockSectionLabel
        label="Brief"
        trailing={
          <button type="button" className={SECTION_ACTION_CLASS} onClick={() => setEditing(!editing)} aria-expanded={editing}>
            {editing ? "Done" : text ? "Edit" : "Write"}
          </button>
        }
      />
      {editing ? (
        <div
          onKeyDown={(event) => {
            // Esc finishes editing, unless the editor used it (the slash list, a link field).
            if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return
            event.preventDefault()
            setEditing(false)
          }}
        >
          <NoteEditor
            briefProjectId={projectId}
            variant="compact"
            autoFocus="body"
            className="thread-note-field"
            placeholder={PROJECT_SPACE_COPY.briefPlaceholder}
            saveFailedText={PROJECT_SPACE_COPY.briefSaveFailed}
          />
          <p id={footId} className="-mt-0.5 px-3.5 pb-1 text-[length:var(--app-font-size-ui-sm,11px)] leading-4 text-pretty text-muted-foreground/60">
            {PROJECT_SPACE_COPY.briefOwner}
          </p>
        </div>
      ) : (
        <button
          type="button"
          className="thread-note-field block w-[calc(100%-16px)] cursor-text text-left outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => setEditing(true)}
          aria-label={text ? "Edit the brief" : "Write the brief"}
          aria-describedby={footId}
        >
          {text ? <BriefText text={text} /> : <span className="block text-[length:var(--n-ui)] leading-[1.55] text-pretty text-[color:var(--n-fg3)]">{PROJECT_SPACE_COPY.briefEmpty}</span>}
          <span id={footId} className="mt-1.5 block text-[length:var(--app-font-size-ui-sm,11px)] leading-4 text-pretty text-muted-foreground/60">
            {PROJECT_SPACE_COPY.briefOwner}
          </span>
        </button>
      )}
    </section>
  )
}

/** A few lines of the brief; a fade says there is more. Measured only when the text changes. */
function BriefText({ text }: { text: string }) {
  const box = useRef<HTMLSpanElement>(null)
  const [overflows, setOverflows] = useState(false)
  useLayoutEffect(() => {
    const node = box.current
    if (node) setOverflows(node.scrollHeight > node.clientHeight + 1)
  }, [text])
  return (
    <span
      ref={box}
      className={cn(
        "block max-h-[7.75em] overflow-hidden text-[length:var(--n-ui)] leading-[1.55] break-words whitespace-pre-line text-[color:var(--n-fg1)]",
        overflows && "[mask-image:linear-gradient(to_bottom,black_55%,transparent)]",
      )}
    >
      {text}
    </span>
  )
}

/** "Give every thread in this project the brief": `projects.update brief_in_all_threads`. */
function BriefSwitch({ projectId }: { projectId: ProjectId }) {
  const checked = useStore((s) => s.projects[projectId]?.brief_in_all_threads ?? false)
  const [busy, setBusy] = useState(false)
  const titleId = useId()
  const detailId = useId()
  const setChecked = (next: boolean) => {
    const set = useStore.getState().set
    const patch = (value: boolean) =>
      set((state) => {
        const project = state.projects[projectId]
        return project ? { projects: { ...state.projects, [projectId]: { ...project, brief_in_all_threads: value } } } : {}
      })
    patch(next)
    setBusy(true)
    rpc()
      .call("projects.update", { project_id: projectId, brief_in_all_threads: next })
      .then((project) => set((state) => ({ projects: { ...state.projects, [project.id]: project } })))
      .catch((error) => {
        patch(!next)
        toast.error(PROJECT_SPACE_COPY.switchFailed, { description: errorText(error) })
      })
      .finally(() => setBusy(false))
  }
  return (
    <div className="mx-1.5 mt-2 mb-1 flex items-start gap-2.5 rounded-lg border border-[color:var(--app-surface-divider)] px-2.5 py-2">
      <div className="min-w-0 flex-1 cursor-default" onClick={() => !busy && setChecked(!checked)}>
        <p id={titleId} className="text-[length:var(--app-font-size-ui,12px)] leading-[1.35] font-medium text-pretty text-foreground/90">{PROJECT_SPACE_COPY.switchTitle}</p>
        <p id={detailId} className="mt-0.5 text-[length:var(--app-font-size-ui-sm,11px)] leading-[1.4] text-pretty text-muted-foreground/65">{PROJECT_SPACE_COPY.switchDetail}</p>
      </div>
      <Switch className="mt-0.5" checked={checked} disabled={busy} onCheckedChange={setChecked} aria-labelledby={titleId} aria-describedby={detailId} />
    </div>
  )
}
