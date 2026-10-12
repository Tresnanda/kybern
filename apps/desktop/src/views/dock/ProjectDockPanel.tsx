// The Coordinator's "Project" dock tab. SEAM, NOT THE DESIGN: RightPanel mounts this only
// when the open thread is the project's Coordinator (`isCoordinatorThread`). The body below
// is a placeholder; the designed surface (editable brief, read-only setup note, memory
// notes, and the "Give every thread in this project the brief" switch) replaces it, built
// from the Notes components. `projectId` is the Coordinator's project; `active` is true
// while the tab is showing, so the pane can stop work when hidden.
import { NoteIcon } from "@/lib/kit/icons"
import type { ProjectId, ThreadId } from "@/protocol"
import { DockEmpty } from "./DockParts"
import { useShownOnce } from "./dockModel"

export function ProjectDockPanel({ projectId, active }: { threadId: ThreadId; projectId: ProjectId; active: boolean }) {
  const shown = useShownOnce(active)
  if (!shown) return null
  return <ProjectDockContent projectId={projectId} />
}

function ProjectDockContent({ projectId }: { projectId: ProjectId }) {
  return (
    <div data-project-panel={projectId} className="flex min-h-0 w-full flex-1 flex-col">
      <DockEmpty icon={<NoteIcon className="size-4" />} title="Project" body="The brief, setup note and memory for this project will appear here." />
    </div>
  )
}
