// Renaming a project changes its display name only, never the folder.

export const PROJECT_RENAME_COPY = {
  menu: "Rename…",
  palette: "Rename project…",
  field: "Project name",
  failure: "Unable to rename the project. Check the connection and try again.",
} as const;

/**
 * The name to save for `input`, or null to cancel: an empty name or one that
 * matches the current name (ignoring surrounding spaces) changes nothing.
 */
export function renamedProject(input: string, current: string): string | null {
  const next = input.trim();
  return next && next !== current ? next : null;
}
