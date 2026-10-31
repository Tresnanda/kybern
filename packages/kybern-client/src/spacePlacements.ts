// The primary daemon's full placement replica, including projects whose owners are offline.
import { mergeProjects, type LogicalProject } from "./machineMerge.ts";
import { isFreeChatProject, type Project, type Space, type SpacePlacement, type SpaceProject } from "./types.ts";
let placements: readonly SpacePlacement[] = [];
let rail: readonly Space[] = [];
let version = 0;
const listeners = new Set<() => void>();
export const getSpacePlacementVersion = () => version;
export function subscribeSpacePlacements(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
interface Batch { version: number; answers: WeakMap<LogicalProject, string | null> }
let contexts = new WeakMap<readonly LogicalProject[], Batch>();
let activeBatch: Batch | undefined;
export function setSpacePlacements(spaces: readonly Space[], next: readonly SpacePlacement[] = []): boolean {
  const changed = JSON.stringify(placements) !== JSON.stringify(next) || JSON.stringify(rail) !== JSON.stringify(spaces);
  if (changed) {
    placements = next; rail = spaces; version++; contexts = new WeakMap(); activeBatch = undefined;
    for (const listener of listeners) listener();
  }
  return changed;
}
export const getSpacePlacements = () => placements;
export const spaceProject = (machine: string, project: Project): SpaceProject => ({ machine_id: machine, project_id: project.id, kind: project.kind ?? "single", repo: project.repo, repos: project.repos ?? [] });
const rank = (a: SpacePlacement, b: SpacePlacement) => a.lamport - b.lamport || (a.signer < b.signer ? -1 : a.signer > b.signer ? 1 : 0) || (a.op_id < b.op_id ? -1 : a.op_id > b.op_id ? 1 : 0);
function descriptor(p: SpaceProject): Project {
  return { id: p.project_id, repo: p.repo, repos: p.repos ?? [], kind: p.kind ?? "single" } as Project;
}
/** Resolve the whole view once per replica/view revision. Per-project rendering then does one weak-map lookup. */
export function prepareSpacePlacements(logicals: readonly LogicalProject[]): void {
  const cached = contexts.get(logicals);
  if (cached?.version === version) { activeBatch = cached; return; }
  const perMachine = new Map<string, Project[]>();
  const entries = new Map<Project, SpacePlacement>();
  const actual = new Map<Project, LogicalProject>();
  const append = (machine: string, project: Project) => {
    let list = perMachine.get(machine);
    if (!list) perMachine.set(machine, (list = []));
    list.push(project);
  };
  for (const p of placements) { const project = descriptor(p.project); entries.set(project, p); append(p.project.machine_id, project); }
  for (const logical of logicals) for (const instance of logical.instances) { actual.set(instance.project, logical); append(instance.machineId, instance.project); }
  const live = new Set(rail.map((s) => s.id));
  const defaultId = rail.find((s) => s.is_default)?.id ?? null;
  const answers = new WeakMap<LogicalProject, string | null>();
  for (const group of mergeProjects(perMachine)) {
    let winner: SpacePlacement | undefined;
    for (const instance of group.instances) {
      const candidate = entries.get(instance.project);
      if (candidate && (!winner || rank(candidate, winner) > 0)) winner = candidate;
    }
    for (const instance of group.instances) {
      const logical = actual.get(instance.project);
      if (!logical) continue;
      const chosen = winner && live.has(winner.space_id) ? winner.space_id : null;
      answers.set(logical, chosen ?? (logical.spaceId && live.has(logical.spaceId) ? logical.spaceId : defaultId));
    }
  }
  activeBatch = { version, answers };
  contexts.set(logicals, activeBatch);
}
/** The existing root-set, unambiguous remote and group semantics are shared with every other merged list. */
export function logicalSpace(logical: LogicalProject, fallback: string | null = null): string | null {
  if (logical.instances.every((i) => isFreeChatProject(i.project.id))) return null;
  if (activeBatch?.version !== version || !activeBatch.answers.has(logical)) prepareSpacePlacements([logical]);
  return activeBatch!.answers.get(logical) ?? fallback;
}
