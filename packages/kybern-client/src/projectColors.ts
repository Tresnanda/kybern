// A project's color: one soft hue per project, the same on the desktop and the
// phone. Projects take hues in the order they were added (oldest first), so the
// first eight never share one; past eight the hues repeat. Chats without a
// project (the free-chat project) take no hue. Nothing is stored: every client
// derives the same hue from the same project list.
import { isFreeChatProject } from "./types.ts";

/** Hues in the order projects take them, spaced so neighbors never look alike. */
export const PROJECT_HUES = [295, 185, 25, 330, 100, 215, 60, 270] as const;

interface ProjectLike {
  id: string;
  created_at: string;
}

function fallbackHue(id: string): number {
  // A project this client has not listed yet: a stable hue from its id.
  let hash = 0;
  for (let at = 0; at < id.length; at++) hash = (hash * 31 + id.charCodeAt(at)) >>> 0;
  return PROJECT_HUES[hash % PROJECT_HUES.length]!;
}

/** Every listed project's hue, by id. */
export function projectHues(projects: Iterable<ProjectLike>): Map<string, number> {
  const ordered = [...projects]
    .filter((project) => !isFreeChatProject(project.id))
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  return new Map(ordered.map((project, index) => [project.id, PROJECT_HUES[index % PROJECT_HUES.length]!]));
}

/** One project's hue among `projects`. */
export function projectHue(id: string, projects: Iterable<ProjectLike>): number {
  return projectHues(projects).get(id) ?? fallbackHue(id);
}

// The map is rebuilt only when the project list object changes.
const cache = new WeakMap<object, Map<string, number>>();

/** `projectHue`, memoized per project collection (an array or an id-keyed record). */
export function cachedProjectHue(id: string, projects: readonly ProjectLike[] | Record<string, ProjectLike>): number {
  let hues = cache.get(projects);
  if (!hues) {
    hues = projectHues(Array.isArray(projects) ? projects : Object.values(projects));
    cache.set(projects, hues);
  }
  return hues.get(id) ?? fallbackHue(id);
}
