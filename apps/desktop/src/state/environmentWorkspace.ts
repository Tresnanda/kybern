// Persist only client workspace state. Credentials and provider settings never
// enter browser storage. Every key belongs to the verified daemon identity.
import type { AppState, RightTab } from "./store"

const rightTabIds: RightTab[] = ["collaboration", "activity", "changes", "terminal", "explorer", "artifacts"]

export const workspaceKey = (environmentId: string) =>
  `kybern.workspace.v1:${environmentId}`

export function readWorkspace(environmentId: string): Partial<AppState> {
  try {
    const value = JSON.parse(
      globalThis.localStorage?.getItem(workspaceKey(environmentId)) ?? "null"
    )
    if (
      !value ||
      value.version !== 1 ||
      typeof value.state !== "object" ||
      !value.state
    )
      return {}
    const stored = value.state
    const selected = stored.selected
    const validSelection =
      selected &&
      (selected.kind === "none" ||
        selected.kind === "pulls" ||
        (selected.kind === "thread" && typeof selected.id === "string") ||
        (selected.kind === "draft" &&
          (selected.draft?.projectId === undefined || typeof selected.draft.projectId === "string")))
    const result: Partial<AppState> = {
      ...(validSelection ? { selected } : {}),
    }
    for (const key of [
      "collapsedProjects",
      "explorerFile",
      "expandedWork",
      "composerDrafts",
      "terminalTabs",
      "activeTerminalTab",
    ] as const) {
      if (
        stored[key] &&
        typeof stored[key] === "object" &&
        !Array.isArray(stored[key])
      )
        result[key] = stored[key]
    }
    // Earlier workspaces opened every panel automatically, so they have no
    // chosen tab list to restore. Start those workspaces with an empty dock.
    result.rightTabs = Array.isArray(stored.rightTabs)
      ? [...new Set<RightTab>(stored.rightTabs.filter((tab: RightTab) => rightTabIds.includes(tab)))]
      : []
    result.rightTab = result.rightTabs.includes(stored.rightTab)
      ? stored.rightTab
      : result.rightTabs[0] ?? null
    if (typeof stored.rightOpen === "boolean")
      result.rightOpen = stored.rightOpen
    if (typeof stored.envOpen === "boolean") result.envOpen = stored.envOpen
    return result
  } catch {
    return {}
  }
}

export function persistWorkspace(environmentId: string, state: AppState): void {
  const {
    selected,
    collapsedProjects,
    explorerFile,
    expandedWork,
    composerDrafts,
    terminalTabs,
    activeTerminalTab,
    rightOpen,
    rightTab,
    rightTabs,
    envOpen,
  } = state
  try {
    globalThis.localStorage?.setItem(
      workspaceKey(environmentId),
      JSON.stringify({
        version: 1,
        state: {
          selected,
          collapsedProjects,
          explorerFile,
          expandedWork,
          composerDrafts,
          terminalTabs,
          activeTerminalTab,
          rightOpen,
          rightTab,
          rightTabs,
          envOpen,
        },
      })
    )
  } catch {
    /* A full or unavailable browser store must not prevent switching. */
  }
}
