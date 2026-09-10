import { threadHasActivity } from "./runtime";
import type { Project, Thread } from "./protocol";

export type ThreadFilter = "All" | "Working" | "Pinned" | "Archived";
export const THREAD_FILTERS: ThreadFilter[] = [
  "All",
  "Working",
  "Pinned",
  "Archived",
];

type Activity = Parameters<typeof threadHasActivity>[1];

// Shared by the full-screen Threads library (compact) and the persistent iPad
// sidebar so both apply identical filtering, search, and pinned-first ordering.
export function filterThreads({
  threads,
  projects,
  activity,
  query,
  filter,
}: {
  threads: Thread[];
  projects: Project[];
  activity: Activity;
  query: string;
  filter: ThreadFilter;
}): Thread[] {
  const needle = query.toLowerCase();
  return threads
    .filter(
      (t) =>
        (filter === "Archived"
          ? t.status === "archived"
          : t.status !== "archived") &&
        (filter !== "Working" || threadHasActivity(t, activity)) &&
        (filter !== "Pinned" || t.pinned) &&
        `${t.title} ${projects.find((p) => p.id === t.project_id)?.name}`
          .toLowerCase()
          .includes(needle),
    )
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.updated_at.localeCompare(a.updated_at),
    );
}

export function relativeTime(at: string) {
  const minutes = Math.max(0, (Date.now() - Date.parse(at)) / 60000);
  return minutes < 1
    ? "Now"
    : minutes < 60
      ? `${Math.floor(minutes)}m`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h`
        : `${Math.floor(minutes / 1440)}d`;
}
