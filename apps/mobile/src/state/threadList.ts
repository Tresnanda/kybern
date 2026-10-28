// The thread lists' rules, shared by the phone Threads screen and the iPad
// sidebar: which threads show (space, scope, agent, search, archived), in what
// order, which children nest under them, and how projects are ordered. Pure, so
// it runs in tests; callers pass what "working" means (runtime activity).
import { nestedThreadRows } from "../../../../packages/kybern-client/src/threadRows.ts";
import { isChildThread, visibleSubagentThreads } from "../../../../packages/kybern-client/src/subagents.ts";
import { inSpace } from "../../../../packages/kybern-client/src/spaces.ts";
import {
  isFreeChatProject,
  PROVIDER_DISPLAY_NAME,
  type Project,
  type ProviderKind,
  type SpaceId,
  type Thread,
} from "../../../../packages/kybern-client/src/types.ts";

export type ThreadScope = "all" | "working" | "pinned";
export const THREAD_SCOPES: readonly { value: ThreadScope; label: string }[] = [
  { value: "all", label: "All" },
  { value: "working", label: "Working" },
  { value: "pinned", label: "Pinned" },
];

export type ThreadFilter = {
  scope: ThreadScope;
  /** Show archived threads instead of the live ones. */
  archived: boolean;
  agent: ProviderKind | null;
  query: string;
};
export const DEFAULT_FILTER: ThreadFilter = { scope: "all", archived: false, agent: null, query: "" };

/** Anything narrows the list (search excluded): children then stay flat under their parent only. */
export const isFiltering = (filter: ThreadFilter) =>
  filter.scope !== "all" || filter.archived || filter.agent !== null || filter.query.trim() !== "";

const byPinnedThenRecent = (a: Thread, b: Thread) =>
  Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at);

/** Top-level threads that pass the filter, pinned first then most recent. */
export function filterThreads({
  threads,
  projects,
  spaceId,
  filter,
  isWorking,
}: {
  threads: readonly Thread[];
  projects: readonly Project[];
  spaceId: SpaceId | null;
  filter: ThreadFilter;
  isWorking: (thread: Thread) => boolean;
}): Thread[] {
  const needle = filter.query.trim().toLowerCase();
  return threads
    .filter((t) => {
      if (isChildThread(t)) return false;
      if (filter.archived ? t.status !== "archived" : t.status === "archived") return false;
      if (!inSpace(t.project_id, projects, spaceId)) return false;
      if (filter.agent && t.provider.kind !== filter.agent) return false;
      if (filter.scope === "pinned" && !t.pinned) return false;
      if (filter.scope === "working" && !isWorking(t)) return false;
      if (!needle) return true;
      const project = projects.find((p) => p.id === t.project_id)?.name ?? "";
      return `${t.title} ${project} ${PROVIDER_DISPLAY_NAME[t.provider.kind] ?? ""}`.toLowerCase().includes(needle);
    })
    .sort(byPinnedThenRecent);
}

export type ThreadRow = {
  thread: Thread;
  depth: number;
  childCount: number;
  open: boolean;
  /** A delegated or subagent child (read from its parent's lineage). */
  child: boolean;
};

/**
 * Rows with children nested under their parents (`nestedThreadRows`): helper
 * threads always, delegated and subagent children while they work or just
 * settled (`visibleSubagentThreads`). A parent with working children starts open.
 * Children of threads that aren't shown never surface on their own.
 */
export function threadRows(
  top: readonly Thread[],
  children: readonly Thread[],
  expanded: Readonly<Record<string, boolean>>,
  options: { now: number; activeId?: string; dismissed?: ReadonlySet<string> },
): ThreadRow[] {
  const shown = new Set(top.map((t) => t.id));
  const visible = visibleSubagentThreads(children, {
    selectedId: options.activeId,
    dismissed: options.dismissed ?? new Set(),
    now: options.now,
  });
  // Keep only children whose chain reaches a shown thread.
  const byId = new Map<string, Thread>([...top, ...visible].map((t) => [t.id, t]));
  const reaches = (thread: Thread) => {
    const seen = new Set<string>();
    let parent = thread.parent_thread_id;
    while (parent && !seen.has(parent)) {
      if (shown.has(parent)) return true;
      seen.add(parent);
      parent = byId.get(parent)?.parent_thread_id;
    }
    return false;
  };
  const kept = visible.filter(reaches);
  const withChildren = new Set(kept.map((t) => t.parent_thread_id));
  return nestedThreadRows([...top, ...kept], expanded, options.activeId, (t) => withChildren.has(t.id)).map(
    (row) => ({ ...row, child: isChildThread(row.thread) }),
  );
}

/** Agents to filter by: those with threads here, plus the chosen one, by name. */
export function threadAgents(threads: readonly Thread[], chosen: ProviderKind | null): ProviderKind[] {
  const kinds = new Set<ProviderKind>();
  for (const t of threads) if (!isChildThread(t)) kinds.add(t.provider.kind);
  if (chosen) kinds.add(chosen);
  const name = (kind: ProviderKind) => PROVIDER_DISPLAY_NAME[kind] ?? kind;
  return [...kinds].sort((a, b) => name(a).localeCompare(name(b)));
}

/** Projects in the reader's order; the rest follow, most recently active first. */
export function orderProjects<P extends { id: string; name: string }>(
  projects: readonly P[],
  order: readonly string[],
  recent: Readonly<Record<string, string>> = {},
): P[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...projects].sort((a, b) => {
    const ra = rank.get(a.id);
    const rb = rank.get(b.id);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return (recent[b.id] ?? "").localeCompare(recent[a.id] ?? "") || a.name.localeCompare(b.name);
  });
}

/** Move a project one place up or down; returns the full new order. */
export function moveInOrder(ids: readonly string[], id: string, offset: -1 | 1): string[] {
  const next = [...ids];
  const from = next.indexOf(id);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= next.length) return next;
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

export type ProjectGroup = { projectId: string; name: string; threads: Thread[] };

/** Threads grouped by project in project order; free chats last. */
export function groupByProject(
  threads: readonly Thread[],
  projects: readonly Project[],
  order: readonly string[],
): ProjectGroup[] {
  const byProject = new Map<string, Thread[]>();
  const recent: Record<string, string> = {};
  for (const t of threads) {
    const list = byProject.get(t.project_id) ?? [];
    list.push(t);
    byProject.set(t.project_id, list);
    if ((recent[t.project_id] ?? "") < t.updated_at) recent[t.project_id] = t.updated_at;
  }
  const known = projects.filter((p) => byProject.has(p.id) && !isFreeChatProject(p.id));
  const groups: ProjectGroup[] = orderProjects(known, order, recent).map((p) => ({
    projectId: p.id,
    name: p.name,
    threads: byProject.get(p.id)!,
  }));
  // Threads of projects this phone hasn't loaded yet still show.
  for (const [projectId, list] of byProject)
    if (!isFreeChatProject(projectId) && !known.some((p) => p.id === projectId))
      groups.push({ projectId, name: "Project", threads: list });
  const free = [...byProject.entries()].find(([id]) => isFreeChatProject(id));
  if (free) groups.push({ projectId: free[0], name: "Free chats", threads: free[1] });
  return groups;
}

/** Threads a project section shows before "Show more". */
export const SECTION_FIRST_PAGE = 10;
/** Threads each "Show more" tap adds. */
export const SECTION_PAGE = 20;
/** The most rows a filtered section mounts at once (matches still show, in pages). */
export const FILTERED_FIRST_PAGE = 30;

/**
 * How many of a section's threads show: the first page, plus one page per
 * "Show more" tap (`pages`), never more than exist. The rest is `remaining`.
 */
export function sectionWindow(total: number, pages: number, first = SECTION_FIRST_PAGE) {
  const shown = Math.min(total, first + Math.max(0, pages) * SECTION_PAGE);
  return { shown, remaining: total - shown };
}

/** What an empty filtered list says. */
export function emptyText(filter: ThreadFilter, agentName?: string): { title: string; detail: string } {
  const agent = agentName ? `${agentName} ` : "";
  if (filter.query.trim())
    return { title: `No threads match “${filter.query.trim()}”`, detail: "Try another search." };
  if (filter.archived) return { title: `No archived ${agent}threads`, detail: "Threads you archive show up here." };
  if (filter.scope === "working") return { title: `No ${agent}threads are working`, detail: "Running agents show up here." };
  if (filter.scope === "pinned") return { title: `No pinned ${agent}threads`, detail: "Pin a thread to keep it at the top." };
  if (agent) return { title: `No ${agent}threads`, detail: "Choose another agent or show all agents." };
  return { title: "No threads yet", detail: "Start a conversation and it shows up here." };
}

/** "Now", "5m", "3h", "2d", "4w". */
export function relativeTime(at: string, now = Date.now()) {
  const minutes = Math.max(0, (now - Date.parse(at)) / 60000);
  if (minutes < 1) return "Now";
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)}d`;
  return `${Math.floor(minutes / 10080)}w`;
}
