// Persist only client workspace state. Credentials and provider settings never
// enter browser storage. Every key belongs to the verified daemon identity.
import type { AppState } from "./store"

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
          typeof selected.draft?.projectId === "string"))
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
    if (
      ["activity", "changes", "terminal", "explorer"].includes(stored.rightTab)
    )
      result.rightTab = stored.rightTab
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
          envOpen,
        },
      })
    )
  } catch {
    /* A full or unavailable browser store must not prevent switching. */
  }
}
