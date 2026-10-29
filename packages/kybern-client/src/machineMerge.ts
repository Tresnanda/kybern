// Merging what each machine lists into one project and thread list (design
// §5.1). Pure functions over plain data. Ids are unique per machine but never
// assumed to be unique across machines, so every index is keyed by
// (machineId, id). Each machine stays the only writer of its own projects and
// threads; nothing here is ever sent back.
import { nestedThreadRows } from "./threadRows.ts";
import { isFreeChatProject, type MachineId, type Origin, type Project, type RepoIdentity, type Thread } from "./types.ts";

/** A thread as a machine lists it. `origin` is set on threads another machine started. */
export type MachineThread = Thread & { origin?: Pick<Origin, "machine_id" | "thread_id"> | null };

/** Index key of a thread or project on one machine. */
export function scopedKey(machineId: MachineId, id: string): string {
  return `${machineId}\u0001${id}`;
}
export const threadKey = scopedKey;
export const projectInstanceKey = scopedKey;

// ---- logical projects ----

export interface ProjectInstance {
  machineId: MachineId;
  project: Project;
  /** The machine is not reachable; this is its last cached copy. */
  offline: boolean;
}

/** One project as the user sees it: every machine's checkout of the same repository. */
export interface LogicalProject {
  /** `root:<root commit>`, `remote:<remote>`, `group:<member keys>` or `local:<machine>:<project>`. */
  key: string;
  /** From the machine the user is at, else the first machine that has it. */
  name: string;
  spaceId: string | null;
  instances: ProjectInstance[];
  /** The instance `name` and `spaceId` came from. */
  primary: ProjectInstance;
  /** The same on every machine and every launch; feed it to the project hue. */
  colorSeed: string;
}

export interface MergeOptions {
  /** The machine the user is at. */
  localMachineId?: MachineId;
  /** Machines in the order the app lists them; others follow by id. */
  machineOrder?: readonly MachineId[];
  /** Machines whose lists are cached copies. */
  offline?: ReadonlySet<MachineId>;
}

function orderedMachines(ids: Iterable<MachineId>, order: readonly MachineId[] | undefined): MachineId[] {
  const present = new Set(ids);
  const first = (order ?? []).filter((id, index, all) => present.has(id) && all.indexOf(id) === index);
  const rest = [...present].filter((id) => !first.includes(id)).sort();
  return [...first, ...rest];
}

/** Every root commit an identity names: the list, plus the smallest one older daemons send alone. */
function rootsOf(identity: RepoIdentity | null | undefined): string[] {
  return [...new Set([...(identity?.root_commit ? [identity.root_commit] : []), ...(identity?.root_commits ?? [])])].sort();
}

function identityKey(identity: RepoIdentity | null | undefined): string | undefined {
  if (identity?.root_commit) return `root:${identity.root_commit}`;
  if (identity?.remote) return `remote:${identity.remote}`;
  return undefined;
}

/** The sorted, distinct repository keys of a group project: what two groups must share to be one project (and one fork target). */
export function groupRepoKeys(project: Pick<Project, "repos">): string[] {
  return [...new Set((project.repos ?? []).map(identityKey).filter((k): k is string => !!k))].sort();
}

interface Entry {
  machineId: MachineId;
  project: Project;
  roots: string[];
  remote?: string;
  key?: string;
}

/**
 * Group every machine's projects by repository identity. The key is the root
 * commit when there is one, else the remote, else the project stays local to
 * its machine. Two clones with the same root commit but different remotes
 * merge: the root commit is the stronger signal.
 *
 * Interpretations (see the work package report): a project with only a remote
 * joins the root-commit group that has the same remote when exactly one such
 * group exists, so a checkout whose root commit is not read yet does not split
 * off; a group project (a folder of several repositories) merges only with
 * another group of the same repositories, never with a single repository; the
 * free chat project never merges.
 */
export function mergeProjects(
  perMachine: ReadonlyMap<MachineId, readonly Project[]>,
  options: MergeOptions & { previous?: readonly LogicalProject[] } = {},
): LogicalProject[] {
  const machines = orderedMachines(perMachine.keys(), options.machineOrder);
  const entries: Entry[] = [];
  for (const machineId of machines)
    for (const project of perMachine.get(machineId) ?? []) {
      const entry: Entry = { machineId, project, roots: [] };
      if (isFreeChatProject(project.id)) entry.key = `local:${machineId}:${project.id}`;
      else if (project.kind === "group") {
        const members = groupRepoKeys(project);
        entry.key = members.length ? `group:${members.join("+")}` : `local:${machineId}:${project.id}`;
      } else {
        entry.roots = rootsOf(project.repo);
        entry.remote = project.repo?.remote || undefined;
      }
      entries.push(entry);
    }

  // Checkouts that share any root commit are one repository (a repository with merged histories has
  // several roots): the group's key is its smallest root.
  const parent = new Map<string, string>();
  const find = (root: string): string => {
    let top = root;
    while (parent.get(top) !== top) top = parent.get(top) ?? top;
    parent.set(root, top);
    return top;
  };
  for (const entry of entries)
    for (const root of entry.roots) if (!parent.has(root)) parent.set(root, root);
  for (const entry of entries)
    for (const root of entry.roots.slice(1)) {
      const a = find(entry.roots[0]!);
      const b = find(root);
      if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
    }
  const rootKey = (root: string) => find(root);

  // Which root commits each remote is known under.
  const rootsOfRemote = new Map<string, Set<string>>();
  for (const entry of entries)
    if (entry.roots.length && entry.remote) {
      const roots = rootsOfRemote.get(entry.remote) ?? new Set<string>();
      roots.add(rootKey(entry.roots[0]!));
      rootsOfRemote.set(entry.remote, roots);
    }
  for (const entry of entries) {
    if (entry.key) continue;
    if (entry.roots.length) entry.key = `root:${rootKey(entry.roots[0]!)}`;
    else if (entry.remote) {
      const roots = rootsOfRemote.get(entry.remote);
      entry.key = roots?.size === 1 ? `root:${[...roots][0]}` : `remote:${entry.remote}`;
    } else entry.key = `local:${entry.machineId}:${entry.project.id}`;
  }

  const offline = options.offline;
  const groups = new Map<string, ProjectInstance[]>();
  for (const entry of entries) {
    const list = groups.get(entry.key!) ?? [];
    list.push({ machineId: entry.machineId, project: entry.project, offline: offline?.has(entry.machineId) ?? false });
    groups.set(entry.key!, list);
  }

  const previous = new Map((options.previous ?? []).map((p) => [p.key, p]));
  const merged: LogicalProject[] = [];
  for (const [key, instances] of groups) {
    const primary = instances.find((i) => i.machineId === options.localMachineId) ?? instances[0]!;
    const old = previous.get(key);
    if (
      old &&
      old.primary.machineId === primary.machineId &&
      old.primary.project === primary.project &&
      old.instances.length === instances.length &&
      old.instances.every(
        (i, index) =>
          i.machineId === instances[index]!.machineId &&
          i.project === instances[index]!.project &&
          i.offline === instances[index]!.offline,
      )
    ) {
      merged.push(old);
      continue;
    }
    merged.push({
      key,
      name: primary.project.name,
      spaceId: primary.project.space_id ?? null,
      instances,
      primary,
      colorSeed: key,
    });
  }
  return merged;
}

// ---- merged threads ----

export interface MergedThread<T extends MachineThread = MachineThread> {
  /** `scopedKey(machineId, thread.id)`: unique across the network. */
  key: string;
  machineId: MachineId;
  thread: T;
  /** The logical project this thread is listed under. */
  projectKey: string;
  offline: boolean;
  /** For an offline machine: when its list was last read, in ms. */
  lastSeenAt?: number;
  /** The thread this one is listed under, on any machine; see `threadParentKey`. */
  parentKey?: string;
}

export interface MergedThreads<T extends MachineThread = MachineThread> {
  /** Every thread, newest `updated_at` first across machines. */
  all: MergedThread<T>[];
  byProject: Map<string, MergedThread<T>[]>;
  byKey: Map<string, MergedThread<T>>;
}

export interface MergeThreadsOptions<T extends MachineThread = MachineThread> {
  offline?: ReadonlySet<MachineId>;
  lastSeenAt?: ReadonlyMap<MachineId, number>;
  /** The previous result: entries that did not change keep their identity. */
  previous?: MergedThreads<T>;
  /** Newest threads kept per machine (default 2000), so one busy machine cannot grow the list without bound. */
  maxPerMachine?: number;
}

/** The thread a thread is listed under: its local parent, else the thread on another machine that started it. */
export function threadParentKey(machineId: MachineId, thread: MachineThread): string | undefined {
  let key: string | undefined;
  if (thread.parent_thread_id) key = scopedKey(machineId, thread.parent_thread_id);
  else if (thread.origin?.thread_id) key = scopedKey(thread.origin.machine_id, thread.origin.thread_id);
  return key && key !== scopedKey(machineId, thread.id) ? key : undefined;
}

function time(text: string | undefined): number {
  const ms = Date.parse(text ?? "");
  return Number.isFinite(ms) ? ms : 0;
}

export function mergeThreads<T extends MachineThread = MachineThread>(
  perMachine: ReadonlyMap<MachineId, readonly T[]>,
  projects: readonly LogicalProject[],
  options: MergeThreadsOptions<T> = {},
): MergedThreads<T> {
  const projectOf = new Map<string, string>();
  for (const project of projects)
    for (const instance of project.instances) projectOf.set(scopedKey(instance.machineId, instance.project.id), project.key);
  const max = options.maxPerMachine ?? 2000;
  const all: MergedThread<T>[] = [];
  for (const [machineId, threads] of perMachine) {
    const offline = options.offline?.has(machineId) ?? false;
    const lastSeenAt = offline ? options.lastSeenAt?.get(machineId) : undefined;
    const kept = threads.length > max ? [...threads].sort((a, b) => time(b.updated_at) - time(a.updated_at)).slice(0, max) : threads;
    for (const thread of kept) {
      const key = scopedKey(machineId, thread.id);
      const projectKey = projectOf.get(scopedKey(machineId, thread.project_id)) ?? `local:${machineId}:${thread.project_id}`;
      const parentKey = threadParentKey(machineId, thread);
      const old = options.previous?.byKey.get(key);
      if (
        old &&
        old.thread === thread &&
        old.offline === offline &&
        old.lastSeenAt === lastSeenAt &&
        old.projectKey === projectKey &&
        old.parentKey === parentKey
      ) {
        all.push(old);
        continue;
      }
      const entry: MergedThread<T> = { key, machineId, thread, projectKey, offline };
      if (lastSeenAt !== undefined) entry.lastSeenAt = lastSeenAt;
      if (parentKey) entry.parentKey = parentKey;
      all.push(entry);
    }
  }
  all.sort((a, b) => time(b.thread.updated_at) - time(a.thread.updated_at) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const byProject = new Map<string, MergedThread<T>[]>();
  const byKey = new Map<string, MergedThread<T>>();
  for (const entry of all) {
    byKey.set(entry.key, entry);
    const list = byProject.get(entry.projectKey) ?? [];
    list.push(entry);
    byProject.set(entry.projectKey, list);
  }
  return { all, byProject, byKey };
}

/**
 * Sidebar rows for merged threads, children under their parent even when the
 * parent is on another machine. A child whose parent is not in `threads` is a
 * root of its own. Same rules as `nestedThreadRows`; keys are merged keys.
 */
export function mergedThreadRows<T extends MachineThread = MachineThread>(
  threads: readonly MergedThread<T>[],
  expanded: Readonly<Record<string, boolean>>,
  activeKey?: string,
  defaultOpen?: (thread: MergedThread<T>) => boolean,
): { thread: MergedThread<T>; depth: number; childCount: number; open: boolean }[] {
  const adapted = threads.map((merged) => ({ id: merged.key, parent_thread_id: merged.parentKey ?? null, merged }));
  return nestedThreadRows(adapted, expanded, activeKey, defaultOpen && ((a) => defaultOpen(a.merged))).map((row) => ({
    thread: row.thread.merged,
    depth: row.depth,
    childCount: row.childCount,
    open: row.open,
  }));
}

// ---- the machine glyph ----

/** The glyph is for networks of more than one machine, and not on the threads of the machine the user is at. */
export function showMachineGlyph(options: { machineCount: number; machineId: MachineId; localMachineId?: MachineId }): boolean {
  return options.machineCount > 1 && options.machineId !== options.localMachineId;
}

export interface MachineGlyph {
  /** One or two characters of the machine's name ("S", "Sa"), upper case first. Stable once assigned. */
  letter: string;
  /** 0-359, derived from the machine id so it is the same on every client. */
  hue: number;
}

function hueOf(machineId: MachineId): number {
  let hash = 2166136261;
  for (let at = 0; at < machineId.length; at++) {
    hash ^= machineId.charCodeAt(at);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash % 360;
}

const isLetter = (char: string) => /\p{L}/u.test(char);

/** "SatyaMas" → Satya, Mas; "srv1544252" → srv, 1544252; "VM-3-60-ubuntu" → VM, 3, 60, ubuntu. */
function nameSegments(name: string): string[][] {
  return name
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{L})(\p{N})|(\p{N})(\p{L})/gu, (_all, a, b, c, d) => `${a ?? c} ${b ?? d}`)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((segment) => Array.from(segment));
}

const upper = (char: string) => char.toUpperCase();
const pair = (first: string, second: string) => upper(first) + second.toLowerCase();

/** The letters a machine may take, best first: its first letter, the first letter of each later word, then two letters ("Sa"). */
export function glyphCandidates(name: string): string[] {
  const segments = nameSegments(name);
  const out: string[] = [];
  const add = (letter: string | undefined) => {
    if (letter && !out.includes(letter)) out.push(letter);
  };
  const letters = segments.filter((segment) => isLetter(segment[0]!));
  for (const segment of letters) add(upper(segment[0]!));
  const lead = letters[0] ?? segments[0];
  if (lead) {
    for (let at = 1; at < lead.length; at++) add(pair(lead[0]!, lead[at]!));
    for (const segment of segments.slice(1)) add(pair(lead[0]!, segment[0]!));
  }
  for (const segment of segments) add(upper(segment[0]!));
  return out;
}

/** A machine's glyph in isolation: its name's first letter. Prefer `machineGlyphs`, which keeps letters distinct and stable. */
export function machineGlyph(machine: { machineId: MachineId; name?: string }): MachineGlyph {
  const source = (machine.name ?? "").trim() || machine.machineId;
  return { letter: glyphCandidates(source)[0] ?? "?", hue: hueOf(machine.machineId) };
}

/**
 * The glyphs of a machine set, with distinct letters that never change once a machine has one. `assigned`
 * is what an earlier call (or the saved machine record) already gave out: those machines keep their letter
 * even when they are renamed. A new machine takes the first free candidate of its name (satyamas and
 * srv1544252 show S and Sr, not S and a letter picked from the middle), in id order so every client agrees.
 * `fresh` lists the letters this call gave out, for the caller to save.
 */
export function machineGlyphs(
  machines: readonly { machineId: MachineId; name?: string }[],
  assigned?: ReadonlyMap<MachineId, string> | Readonly<Record<MachineId, string | undefined>>,
): Map<MachineId, MachineGlyph> & { fresh: Map<MachineId, string> } {
  const had = (id: MachineId) => (assigned instanceof Map ? assigned.get(id) : (assigned as Record<MachineId, string | undefined> | undefined)?.[id]);
  const taken = new Set<string>();
  const glyphs = new Map<MachineId, MachineGlyph>() as Map<MachineId, MachineGlyph> & { fresh: Map<MachineId, string> };
  glyphs.fresh = new Map();
  const ordered = [...machines].sort((a, b) => (a.machineId < b.machineId ? -1 : a.machineId > b.machineId ? 1 : 0));
  for (const machine of ordered) {
    const kept = had(machine.machineId);
    if (kept) {
      taken.add(kept);
      glyphs.set(machine.machineId, { letter: kept, hue: hueOf(machine.machineId) });
    }
  }
  for (const machine of ordered) {
    if (glyphs.has(machine.machineId)) continue;
    const source = (machine.name ?? "").trim() || machine.machineId;
    const candidates = glyphCandidates(source);
    const letter = candidates.find((candidate) => !taken.has(candidate)) ?? candidates[0] ?? "?";
    taken.add(letter);
    glyphs.set(machine.machineId, { letter, hue: hueOf(machine.machineId) });
    glyphs.fresh.set(machine.machineId, letter);
  }
  return glyphs;
}
