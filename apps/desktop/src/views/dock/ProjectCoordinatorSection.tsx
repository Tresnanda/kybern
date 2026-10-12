// The Project tab's "Coordinator" section: this project's overrides of the Coordinator
// settings (autonomy, where agents work, pushing without asking, a model per kind of
// work) over the global defaults in Settings › Delegation, and "Redo setup". Every change
// sends the whole override object with `projects.update { coordinator }`, shown at once
// and rolled back with a toast if the daemon refuses it.
import { useMemo, useState } from "react"
import { toast } from "sonner"

import type { CoordinatorOverrides, CoordinatorRole, ProjectId, ProviderInstance, RoleDefault, ThreadId } from "@/protocol"
import { errorText, rpc } from "@/state/rpc"
import { useStore } from "@/state/store"
import {
  COORDINATOR_ROLES,
  COORDINATOR_SETTINGS_COPY,
  effectiveCoordinatorSettings,
  roleChip,
  withOverrideField,
  withRoleOverride,
  type RoleChip,
} from "../../../../../packages/kybern-client/src/coordinatorSettings"
import { AutonomyField, ConfirmAction, PushField, RoleModelList, WorkspaceField, COORDINATOR_FIELD_LABEL_CLASS } from "../coordinator/CoordinatorControls"
import { DockSectionLabel } from "./DockParts"

/** Same quiet text action as the Brief's "Edit". */
const SECTION_ACTION_CLASS =
  "press flex h-5 items-center rounded-md px-1.5 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/70 outline-hidden transition-colors hover:bg-[var(--sidebar-accent)] hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
const FOOTER_ACTION_CLASS =
  "press flex h-6 items-center rounded-md px-1.5 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/70 outline-hidden transition-colors hover:bg-[var(--sidebar-accent)] hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45"

const FALLBACK_PROVIDER: ProviderInstance = { kind: "claude-code", instance: "default" }

/** Write the project's overrides: shown now, kept when the daemon agrees, rolled back when it does not. */
async function saveProjectCoordinator(projectId: ProjectId, next: CoordinatorOverrides | null): Promise<boolean> {
  const set = useStore.getState().set
  const before = useStore.getState().projects[projectId]
  if (!before) return false
  const patch = (value: CoordinatorOverrides | null | undefined) =>
    set((state) => {
      const project = state.projects[projectId]
      return project ? { projects: { ...state.projects, [projectId]: { ...project, coordinator: value } } } : {}
    })
  patch(next)
  try {
    const project = await rpc().call("projects.update", { project_id: projectId, coordinator: next })
    set((state) => ({ projects: { ...state.projects, [project.id]: project } }))
    return true
  } catch (error) {
    patch(before.coordinator)
    toast.error(COORDINATOR_SETTINGS_COPY.saveFailed, { description: errorText(error) })
    return false
  }
}

/** "Redo setup": the daemon starts the interview again, or says why it cannot yet. */
async function redoCoordinatorSetup(projectId: ProjectId): Promise<void> {
  try {
    const thread = await rpc().call("coordinator.setup", { project_id: projectId })
    useStore.getState().set((state) => ({ threads: { ...state.threads, [thread.id]: thread } }))
  } catch (error) {
    toast.error(COORDINATOR_SETTINGS_COPY.redoFailed, { description: errorText(error) })
  }
}

export function ProjectCoordinatorSection({ projectId, threadId }: { projectId: ProjectId; threadId: ThreadId }) {
  const overrides = useStore((s) => s.projects[projectId]?.coordinator ?? null)
  const orchestration = useStore((s) => s.settings?.orchestration)
  const providers = useStore((s) => s.providers)
  const coordinatorProvider = useStore((s) => s.threads[threadId]?.provider)
  const [busy, setBusy] = useState(false)
  const effective = useMemo(() => effectiveCoordinatorSettings(orchestration, overrides), [orchestration, overrides])
  const chips = useMemo(
    () => Object.fromEntries(COORDINATOR_ROLES.map(({ role }) => [role, roleChip(role, orchestration, overrides, providers, "project")])) as Record<CoordinatorRole, RoleChip>,
    [orchestration, overrides, providers],
  )

  const write = async (next: CoordinatorOverrides | null) => {
    setBusy(true)
    try { return await saveProjectCoordinator(projectId, next) }
    finally { setBusy(false) }
  }
  // Read the store at the moment of the change, so two quick edits build on each other.
  const current = () => useStore.getState().projects[projectId]?.coordinator ?? null
  const setRole = (role: CoordinatorRole, value: RoleDefault | null) => write(withRoleOverride(current(), role, value))

  return (
    <section aria-label={COORDINATOR_SETTINGS_COPY.section} className="mt-2" data-coordinator-section={projectId}>
      <DockSectionLabel
        label={COORDINATOR_SETTINGS_COPY.section}
        trailing={
          <ConfirmAction
            label={COORDINATOR_SETTINGS_COPY.redo}
            title={COORDINATOR_SETTINGS_COPY.redoTitle}
            detail={COORDINATOR_SETTINGS_COPY.redoDetail}
            confirm={COORDINATOR_SETTINGS_COPY.redo}
            onConfirm={() => void redoCoordinatorSetup(projectId)}
            className={SECTION_ACTION_CLASS}
          />
        }
      />
      <div className="mx-1.5 flex flex-col gap-3.5 rounded-lg border border-[color:var(--app-surface-divider)] px-2.5 pt-2.5 pb-1.5">
        <AutonomyField value={effective.lead_autonomy} busy={busy} onChange={(value) => void write(withOverrideField(current(), "lead_autonomy", value))} />
        <WorkspaceField value={effective.lead_workspace} busy={busy} onChange={(value) => void write(withOverrideField(current(), "lead_workspace", value))} />
        <PushField checked={effective.lead_push_without_asking} busy={busy} onChange={(value) => void write(withOverrideField(current(), "lead_push_without_asking", value))} />
        <div>
          <p className={COORDINATOR_FIELD_LABEL_CLASS}>{COORDINATOR_SETTINGS_COPY.models}</p>
          <RoleModelList
            chips={chips}
            values={overrides?.role_defaults ?? {}}
            fallbackProvider={coordinatorProvider ?? FALLBACK_PROVIDER}
            defaultHint="Follow Settings › Delegation for this kind of work"
            onChange={setRole}
            busy={busy}
          />
        </div>
        <div className="-mx-1 flex items-center justify-between gap-2">
          <button
            type="button"
            className={FOOTER_ACTION_CLASS}
            onClick={() => useStore.getState().set({ settingsOpen: true, settingsTab: "agents", settingsFocus: "coordinator-defaults" })}
          >
            {COORDINATOR_SETTINGS_COPY.defaultsFrom}
          </button>
          <ConfirmAction
            label={COORDINATOR_SETTINGS_COPY.reset}
            title={COORDINATOR_SETTINGS_COPY.resetTitle}
            detail={COORDINATOR_SETTINGS_COPY.resetDetail}
            confirm={COORDINATOR_SETTINGS_COPY.reset}
            disabled={!overrides || busy}
            onConfirm={() => void write(null)}
            className={FOOTER_ACTION_CLASS}
          />
        </div>
      </div>
    </section>
  )
}
