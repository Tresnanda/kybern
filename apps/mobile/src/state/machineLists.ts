// The thread and project lists Home, Threads and the iPad sidebar show once
// there is more than one machine (design §5.3). Pure: it takes the machine set's
// merged view and returns the same shapes the single-computer screens already
// read (`Project[]`, `Thread[]`), so grouping, search, spaces and rows keep their
// rules. A thread of another machine is shown under the logical project it
// belongs to (the same repository on any machine), which means its `project_id`
// is rewritten to that project's id for display only. Ids are unique per machine,
// not across machines; if two machines list one id, the first in machine order wins.
import { logicalSpace, prepareSpacePlacements } from "../../../../packages/kybern-client/src/spacePlacements";
import type { MergedThread } from "../../../../packages/kybern-client/src/machineMerge";
import type { MachineSummary, MergedView } from "../../../../packages/kybern-client/src/machines";
import type { MachineId, Project, Thread, ThreadActivitySummary } from "../../../../packages/kybern-client/src/types";

export interface ThreadMachine {
  machineId: MachineId;
  name: string;
  glyph: MachineSummary["glyph"];
  /** The glyph is shown on this thread's row (more than one machine, and not the machine the user is at). */
  showGlyph: boolean;
  /** The machine is not reachable; the thread is a cached copy. */
  offline: boolean;
  lastSeenAt?: number;
}

export interface ListsView {
  projects: Project[];
  threads: Thread[];
  activity: ThreadActivitySummary[];
  /** Empty with one machine: the screens then look exactly as they did. */
  machines: MachineSummary[];
  showGlyphs: boolean;
  /** Where a listed thread lives; undefined with one machine. */
  machineOfThread(threadId: string): ThreadMachine | undefined;
  /** The machine and the project id a thread has on it, for writes. */
  ownerOf(threadId: string): { machineId: MachineId; thread: Thread } | undefined;
}

export interface SingleLists {
  projects: Project[];
  threads: Thread[];
  activity: ThreadActivitySummary[];
}

export const ALL_MACHINES = null;

/** Display copies of other machines' threads, reused while neither the thread nor its project id changes. */
const copies = new WeakMap<Thread, Map<string, Thread>>();
function displayThread(thread: Thread, projectId: string): Thread {
  if (thread.project_id === projectId) return thread;
  let byProject = copies.get(thread);
  if (!byProject) copies.set(thread, (byProject = new Map()));
  let copy = byProject.get(projectId);
  if (!copy) byProject.set(projectId, (copy = { ...thread, project_id: projectId }));
  return copy;
}

export function singleMachineLists(lists: SingleLists): ListsView {
  return {
    ...lists,
    machines: [],
    showGlyphs: false,
    machineOfThread: () => undefined,
    ownerOf: () => undefined,
  };
}

/**
 * `filter` is a machine id to show only that machine, or null for all of them.
 * With one known machine, or none, `local` is returned untouched.
 */
export function buildLists(
  view: MergedView,
  local: SingleLists,
  filter: MachineId | null = ALL_MACHINES,
  activityOf: (machineId: MachineId) => readonly ThreadActivitySummary[] | undefined = () => undefined,
): ListsView {
  if (view.machines.length <= 1) return singleMachineLists(local);
  prepareSpacePlacements(view.projects);
  const machines = new Map(view.machines.map((m) => [m.machineId, m]));
  const only = filter && machines.has(filter) ? filter : null;

  // One project per logical project, from the machine asked for, else the one the user is at.
  const projects: Project[] = [];
  const projectIdOf = new Map<string, string>();
  for (const logical of view.projects) {
    const instance = (only && logical.instances.find((i) => i.machineId === only)) || (only ? undefined : logical.primary);
    if (!instance) continue;
    const space = logicalSpace(logical);
    projects.push(space && instance.project.space_id !== space ? displayProject(instance.project, space) : instance.project);
    projectIdOf.set(logical.key, instance.project.id);
  }

  const threads: Thread[] = [];
  const byThread = new Map<string, MergedThread>();
  for (const entry of view.threads.all) {
    if (only && entry.machineId !== only) continue;
    const id = entry.thread.id;
    if (byThread.has(id)) continue;
    byThread.set(id, entry);
    const projectId = projectIdOf.get(entry.projectKey);
    threads.push(projectId ? displayThread(entry.thread, projectId) : entry.thread);
  }
  const activity: ThreadActivitySummary[] = [];
  const listed = new Set(byThread.keys());
  for (const machine of view.machines) {
    if (only && machine.machineId !== only) continue;
    for (const item of activityOf(machine.machineId) ?? []) if (listed.has(item.thread_id)) activity.push(item);
  }

  return {
    projects,
    threads,
    activity,
    machines: view.machines,
    showGlyphs: view.showGlyphs,
    machineOfThread(threadId) {
      const entry = byThread.get(threadId);
      const machine = entry && machines.get(entry.machineId);
      if (!entry || !machine) return undefined;
      return {
        machineId: machine.machineId,
        name: machine.name,
        glyph: machine.glyph,
        showGlyph: machine.showGlyph,
        offline: entry.offline,
        ...(entry.lastSeenAt !== undefined ? { lastSeenAt: entry.lastSeenAt } : {}),
      };
    },
    ownerOf(threadId) {
      const entry = byThread.get(threadId);
      return entry && { machineId: entry.machineId, thread: entry.thread };
    },
  };
}

const projectCopies = new WeakMap<Project, { space: string; project: Project }>();
function displayProject(project: Project, space: string): Project {
  const old = projectCopies.get(project);
  if (old?.space === space) return old.project;
  const copy = { ...project, space_id: space };
  projectCopies.set(project, { space, project: copy });
  return copy;
}
