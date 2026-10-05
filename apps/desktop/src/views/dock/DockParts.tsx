// Shared pieces of the dock's Notes and Tasks panes: the scope header, section labels,
// the "Show all" footer and empty states. Row classes and hooks are in `dockModel.ts`.
import { ProjectDot } from "@/lib/kit/projectDot"
import type { ProjectId } from "@/protocol"
import { useStore } from "@/state/store"

/** The pane's scope: the project's dot and name (or Global), with the pane's main action. */
export function DockScopeHeader({ projectId, action }: { projectId: ProjectId | null; action?: React.ReactNode }) {
  const name = useStore((s) => (projectId ? s.projects[projectId]?.name : undefined))
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 pr-1.5 pl-3.5">
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        <ProjectDot projectId={projectId} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui,12px)] font-medium text-foreground/85">{projectId ? name ?? "Project" : "Global"}</span>
      {action}
    </div>
  )
}

export function DockSectionLabel({ label, count, trailing }: { label: string; count?: number; trailing?: React.ReactNode }) {
  return (
    <div className="flex h-7 items-center gap-1.5 pr-1.5 pl-3.5">
      <h3 className="min-w-0 truncate text-[length:var(--app-font-size-ui-sm,11px)] font-normal text-muted-foreground/58">{label}</h3>
      {count !== undefined && <span className="text-[length:var(--app-font-size-ui-sm,11px)] tabular-nums text-muted-foreground/40">{count}</span>}
      {trailing && <span className="ml-auto flex shrink-0 items-center">{trailing}</span>}
    </div>
  )
}

/** A quiet text action under a list: "Show all in Tasks". */
export function DockFooterLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="press mx-1.5 mt-1 mb-2 flex h-7 items-center rounded-md px-2 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/70 outline-hidden transition-colors hover:bg-[var(--sidebar-accent)] hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
    >
      {label}
    </button>
  )
}

/** Centered empty state, the same shape as the Activity pane's. */
export function DockEmpty({ icon, title, body, action }: { icon: React.ReactNode; title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 py-10 text-center font-system-ui">
      <span className="mb-3 flex size-8 items-center justify-center rounded-lg bg-[var(--color-background-elevated-secondary)] text-muted-foreground/70">{icon}</span>
      <p className="text-[length:var(--app-font-size-ui,12px)] font-medium text-foreground/80">{title}</p>
      <p className="mt-1 max-w-64 text-[length:var(--app-font-size-ui-sm,11px)] leading-4 text-pretty text-muted-foreground/60">{body}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}

/** A one-line hint inside a list section, for an empty section under other content. */
export function DockHint({ children }: { children: React.ReactNode }) {
  return <p className="px-3.5 pt-0.5 pb-2 text-[length:var(--app-font-size-ui-sm,11px)] leading-4 text-pretty text-muted-foreground/60">{children}</p>
}
