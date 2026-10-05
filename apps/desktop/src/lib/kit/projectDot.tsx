// A project's color, shown only as a small dot (Notes, Tasks, the palette, pickers).
// One soft hue per project, assigned in the order projects were added so the first
// eight never collide, and derived the same way on the phone
// (packages/kybern-client/src/projectColors.ts). Global is an empty ring. Lightness
// and chroma are theme tokens (`.project-dot` in styles/notes.css), so the dots
// read in light, dark and increased contrast alike.
import { cachedProjectHue } from "../../../../../packages/kybern-client/src/projectColors.ts"
import { cn } from "@/lib/utils"
import { useStore } from "@/state/store"

/** A project's hue among the active environment's projects. */
export function useProjectHue(projectId: string | null | undefined): number {
  return useStore((s) => (projectId ? cachedProjectHue(projectId, s.projects) : 0))
}

/** A 7px dot in the project's hue, or an empty ring for Global (no project). */
export function ProjectDot({ projectId, className }: { projectId: string | null | undefined; className?: string }) {
  const hue = useProjectHue(projectId)
  return (
    <i
      aria-hidden="true"
      data-global={projectId ? undefined : ""}
      className={cn("project-dot", className)}
      style={projectId ? ({ "--project-hue": hue } as React.CSSProperties) : undefined}
    />
  )
}

/** A small progress ring for a checklist: the done share drawn over a faint track. */
export function ChecklistRing({ done, total, className }: { done: number; total: number; className?: string }) {
  const r = 4.75
  const circumference = 2 * Math.PI * r
  const share = total > 0 ? Math.min(1, done / total) : 0
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className={cn("checklist-ring shrink-0", className)}>
      <circle cx="6" cy="6" r={r} fill="none" stroke="currentColor" strokeOpacity="0.32" strokeWidth="1.4" />
      {share > 0 && (
        <circle
          cx="6"
          cy="6"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeDasharray={`${(share * circumference).toFixed(2)} ${circumference.toFixed(2)}`}
          transform="rotate(-90 6 6)"
        />
      )}
    </svg>
  )
}
