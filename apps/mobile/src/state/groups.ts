// Mobile glue for group projects. Labels, ordering and validation live in
// packages/kybern-client/src/groups.ts; this file maps the phone's draft and
// screens onto them and onto the RPC shapes, so it stays pure and testable.
import {
  GROUP_FOLDER_MEMBER,
  branchChipLabel,
  isGroupProject,
  orderMemberPaths,
} from "../../../../packages/kybern-client/src/groups.ts";
import type {
  PullRequest,
  RepoCandidate,
  RepoGitStatus,
} from "../../../../packages/kybern-client/src/types.ts";

type ProjectLike = {
  id: string;
  is_git: boolean;
  kind?: "single" | "group";
  members?: { path: string; name: string; status: string }[];
};

/** First daemon that speaks group projects; older ones hide the group UI. */
export const GROUPS_MIN_VERSION = "0.15.0";

/** True when `version` ("0.15.0", "0.15.0-dev", "v0.16.2") is at least `minimum`. */
export function versionAtLeast(version: string | null | undefined, minimum = GROUPS_MIN_VERSION): boolean {
  if (!version) return false;
  const parse = (value: string) => value.replace(/^v/, "").split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(version);
  const b = parse(minimum);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index]! > b[index]!;
  }
  return true;
}

/** Group projects always run in git repositories, even when the group folder itself is not one. */
export const supportsWorktree = (project: ProjectLike | null | undefined): boolean =>
  !!project && (project.is_git || isGroupProject(project));

/** Members a new chat can use: present repositories, in project order. */
export const availableMembers = (project: ProjectLike | null | undefined) =>
  (project?.members ?? []).filter((member) => member.status === "ok");

/** The draft's group choices, kept per project so switching projects never leaks them. */
export interface GroupDraft {
  /** The project these choices were made for. */
  groupProjectId: string;
  /** Members to include in a worktree chat; null means every member. */
  members: string[] | null;
  /** Base branch per member path; a missing entry keeps that repository's current branch. */
  baseBranches: Record<string, string>;
}

export const emptyGroupDraft: GroupDraft = { groupProjectId: "", members: null, baseBranches: {} };

/** The draft's choices for `project`, or the defaults when they were made for another one. */
export function groupDraftFor(project: ProjectLike | null | undefined, draft: GroupDraft): GroupDraft {
  return project && draft.groupProjectId === project.id ? draft : { ...emptyGroupDraft, groupProjectId: project?.id ?? "" };
}

/** Included member paths for a worktree chat (all available ones by default). */
export function includedPaths(project: ProjectLike | null | undefined, draft: GroupDraft): string[] {
  const available = availableMembers(project).map((member) => member.path);
  const own = groupDraftFor(project, draft).members;
  if (!own) return available;
  const kept = available.filter((path) => own.includes(path));
  return kept.length ? kept : available;
}

/**
 * Tick or untick a member. The last included one can't be unticked: a chat needs
 * at least one repository. Returns null for "every member" so new members join.
 */
export function toggleIncluded(project: ProjectLike, draft: GroupDraft, path: string): string[] | null {
  const available = availableMembers(project).map((member) => member.path);
  const current = includedPaths(project, draft);
  const next = current.includes(path) ? current.filter((item) => item !== path) : [...current, path];
  if (!next.length) return draft.groupProjectId === project.id ? draft.members : null;
  const ordered = available.filter((item) => next.includes(item));
  return ordered.length === available.length ? null : ordered;
}

/** Whether unticking `path` is refused because it is the only repository left. */
export const isLastIncluded = (project: ProjectLike, draft: GroupDraft, path: string): boolean => {
  const current = includedPaths(project, draft);
  return current.length === 1 && current[0] === path;
};

/** `threads.create` fields for a group project; empty for single projects. */
export function groupCreateFields(
  project: ProjectLike | null | undefined,
  draft: GroupDraft,
  worktree: boolean,
): { members?: string[]; base_branches?: Record<string, string> } {
  if (!project || !isGroupProject(project)) return {};
  const own = groupDraftFor(project, draft);
  const available = availableMembers(project).map((member) => member.path);
  const fields: { members?: string[]; base_branches?: Record<string, string> } = {};
  if (worktree) {
    const included = includedPaths(project, own);
    if (included.length < available.length) fields.members = included;
  }
  const usable = worktree ? includedPaths(project, own) : available;
  const branches = Object.fromEntries(
    Object.entries(own.baseBranches).filter(([path, branch]) => usable.includes(path) && !!branch.trim()),
  );
  if (Object.keys(branches).length) fields.base_branches = branches;
  return fields;
}

/** The collapsed Base branches detail: "main +2", from chosen branches or each repository's current one. */
export function baseBranchesSummary(paths: readonly string[], chosen: Record<string, string>, current: Record<string, string | null | undefined>): string {
  const [primary, ...others] = paths;
  if (!primary) return "Current branches";
  const { label, extra } = branchChipLabel(chosen[primary] || current[primary] || "Current branch", others.length);
  return extra ? `${label} ${extra}` : label;
}

/** A detail line for a checklist row: "services/billing · main", "a1b2c3d (detached)". */
export function candidateDetail(candidate: Pick<RepoCandidate, "path" | "name" | "branch" | "detached">): string {
  const branch = candidate.branch ? (candidate.detached ? `${candidate.branch} (detached)` : candidate.branch) : "";
  const location = candidate.path !== GROUP_FOLDER_MEMBER && candidate.path !== candidate.name ? candidate.path : "";
  return [location, branch].filter(Boolean).join(" · ");
}

/** Tick or untick a scan candidate, keeping the daemon's member order. */
export function toggleCandidate(selected: readonly string[], path: string): string[] {
  return orderMemberPaths(selected.includes(path) ? selected.filter((item) => item !== path) : [...selected, path]);
}

/** Toggle an entry of "Also copy into worktrees", sorted by name like the daemon's candidates. */
export function toggleCopyEntry(entries: readonly string[], name: string): string[] {
  const next = entries.includes(name) ? entries.filter((item) => item !== name) : [...entries, name];
  return [...new Set(next)].sort((a, b) => a.localeCompare(b));
}

export interface RepoPullRow {
  repo: string;
  name: string;
  pullRequest: PullRequest;
  /** "Open · links to web #77". */
  detail: string;
}

/** One pull request row per member that has one, each naming the others it links to. */
export function repoPullRows(repos: readonly Pick<RepoGitStatus, "repo" | "name" | "pull_request">[]): RepoPullRow[] {
  const withPr = repos.filter((repo): repo is typeof repo & { pull_request: PullRequest } => !!repo.pull_request);
  return withPr.map((repo) => {
    const state = repo.pull_request.is_draft ? "Draft" : capitalize(repo.pull_request.state);
    const others = withPr.filter((other) => other.repo !== repo.repo).map((other) => `${other.name} #${other.pull_request.number}`);
    return {
      repo: repo.repo,
      name: repo.name,
      pullRequest: repo.pull_request,
      detail: others.length ? `${state} · links to ${others.join(", ")}` : state,
    };
  });
}

const capitalize = (value: string) => (value ? value.charAt(0).toUpperCase() + value.slice(1).toLowerCase() : value);

/** Which included members get a pull request from "Create N pull requests", and which are named as skipped. */
export function prPlan(
  repos: readonly Pick<RepoGitStatus, "repo" | "name" | "included" | "remote_url" | "pull_request">[],
  changed: ReadonlySet<string>,
): { create: string[]; unchanged: string[]; noRemote: string[] } {
  const create: string[] = [];
  const unchanged: string[] = [];
  const noRemote: string[] = [];
  for (const repo of repos) {
    if (!repo.included || repo.pull_request) continue;
    if (!changed.has(repo.repo)) unchanged.push(repo.name);
    // The daemon opens pull requests only for github.com remotes (`has_github_remote`).
    else if (!repo.remote_url?.includes("github.com")) noRemote.push(repo.name);
    else create.push(repo.name);
  }
  return { create, unchanged, noRemote };
}
