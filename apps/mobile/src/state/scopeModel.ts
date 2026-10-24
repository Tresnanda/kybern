// The project filter on Notes and Tasks: every project of the space, Global
// items only, or one project. Pure, so the rules are testable.

/** "all" (the space's projects and Global), "global", or a project id. */
export type ProjectScope = "all" | "global" | (string & {});

/**
 * The filter to apply: a project outside `projectIds` (another space, or gone)
 * falls back to "all". `pinned` is a project a link asked for, kept even when
 * it belongs to another space.
 */
export function resolveScope(
  value: ProjectScope,
  projectIds: readonly string[],
  pinned?: string,
): ProjectScope {
  if (value === "all" || value === "global") return value;
  return value === pinned || projectIds.includes(value) ? value : "all";
}

/** What the filter control reads: "All projects", "Global", or the project's name. */
export function scopeLabel(
  scope: ProjectScope,
  projects: readonly { id: string; name: string }[],
): string {
  if (scope === "all") return "All projects";
  if (scope === "global") return "Global";
  return projects.find((p) => p.id === scope)?.name ?? "Project";
}
