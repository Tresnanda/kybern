// Group projects: a parent folder whose members are separate git repositories.
// Pure helpers and copy shared by GPUIX and mobile so both clients match. The
// daemon owns validation and the agents' repository note; these rules only
// mirror it so the UI can explain what is missing before a call fails.
import type { Diff, FileChange, Project, ThreadMember, ThreadsWorkspaceProgress } from "./types.ts";

/** "." is the group folder itself when it is a repository. */
export const GROUP_FOLDER_MEMBER = ".";
/** Fewest members a group can have; "." counts as one. */
export const GROUP_MIN_MEMBERS = 2;

/** Anything with a member path and display name: `ProjectMember`, `ThreadMember`, `MemberState`, `RepoCandidate`. */
export interface MemberLike {
  path: string;
  name: string;
}

export const isGroupProject = (project: Pick<Project, "kind"> | null | undefined): boolean => project?.kind === "group";

/** True for a thread of a group project (it carries a member snapshot). */
export const isGroupThread = (thread: { members?: readonly unknown[] | null } | null | undefined): boolean =>
  (thread?.members?.length ?? 0) > 0;

/** The primary member: the group folder when it is a member, else the first by path. */
export const primaryMember = <M extends MemberLike>(project: { members?: readonly M[] | null }): M | undefined => project.members?.[0];

/** Thread members that have a checkout in this chat. */
export const includedMembers = (members: readonly ThreadMember[] | null | undefined): ThreadMember[] =>
  (members ?? []).filter((member) => member.included && !member.missing);

/** Members in the daemon's order: "." first, then by path (code-unit order, like the daemon). Duplicates dropped. */
export function orderMemberPaths(paths: readonly string[]): string[] {
  const unique = [...new Set(paths)];
  return unique.sort((a, b) => {
    if (a === b) return 0;
    if (a === GROUP_FOLDER_MEMBER) return -1;
    if (b === GROUP_FOLDER_MEMBER) return 1;
    return a < b ? -1 : 1;
  });
}

/** `api/src/x.rs` in member `api` → `src/x.rs`. The "." member keeps the path. */
export function stripRepoPrefix(path: string, repo: string): string {
  if (repo === GROUP_FOLDER_MEMBER || repo === "") return path;
  return path.startsWith(`${repo}/`) ? path.slice(repo.length + 1) : path;
}

/** The member a cwd-relative path belongs to: the longest member path that prefixes it, else ".". */
export function memberForPath<M extends MemberLike>(path: string, members: readonly M[]): M | undefined {
  let best: M | undefined;
  for (const member of members) {
    if (member.path === GROUP_FOLDER_MEMBER) continue;
    const contains = path === member.path || path.startsWith(`${member.path}/`);
    if (contains && member.path.length > (best?.path.length ?? 0)) best = member;
  }
  return best ?? members.find((member) => member.path === GROUP_FOLDER_MEMBER);
}

// ---- counts and labels ----

const plural = (count: number, one: string, other: string) => (count === 1 ? one : other);
const repos = (count: number) => `${count} ${plural(count, "repo", "repos")}`;
const repositories = (count: number) => `${count} ${plural(count, "repository", "repositories")}`;
const files = (count: number) => `${count} ${plural(count, "file", "files")}`;

/** "a, b and c". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Sidebar badge: "3 repos". */
export function repoBadge(count: number): string {
  return repos(count);
}

/** Accessible name of a group project row: "acme-platform, group of 3 repositories". */
export function groupRowLabel(name: string, count: number): string {
  return `${name}, group of ${repositories(count)}`;
}

/** Badge tooltip heading: "3 repositories in ~/work/acme". */
export function repoBadgeTooltip(count: number, folder: string): string {
  return `${repositories(count)} in ${folder}`;
}

/** Branch chip: the primary's branch plus how many other repositories the chat spans ("main", "+2"). */
export function branchChipLabel(primaryBranch: string | null | undefined, others: number): { label: string; extra?: string } {
  const label = primaryBranch || "Branch";
  return others > 0 ? { label, extra: `+${others}` } : { label };
}

/** Repositories chip: "3 repos" when all are in the chat, "2 of 3 repos", or "api only" for one. */
export function reposChipLabel(includedNames: readonly string[], total: number): string {
  if (includedNames.length === 1 && total > 1) return `${includedNames[0]} only`;
  if (includedNames.length === total) return repos(total);
  return `${includedNames.length} of ${repos(total)}`;
}

/** Changed repositories next to a diff total: "2 of 3 repos", or "3 repos" when every one changed. */
export function changedReposLabel(changed: number, total: number): string {
  return changed === total ? repos(total) : `${changed} of ${repos(total)}`;
}

/** Checklist count: "2 of 4 selected". */
export function selectedCountLabel(selected: number, total: number): string {
  return `${selected} of ${total} selected`;
}

/** Why the selection can't be a group yet, or null when it can. "." counts as a member. */
export function memberSelectionError(selected: readonly string[]): string | null {
  const count = new Set(selected).size;
  if (count === 0) return "Select at least 2 repositories.";
  if (count < GROUP_MIN_MEMBERS) {
    const missing = GROUP_MIN_MEMBERS - count;
    return `Select ${missing} more ${plural(missing, "repository", "repositories")}.`;
  }
  return null;
}

/** The helper line above the sheet buttons: what is missing, or what the group will be. */
export function memberSelectionHelper(selected: readonly string[]): string {
  const error = memberSelectionError(selected);
  if (error) return error;
  const count = new Set(selected).size;
  if (selected.includes(GROUP_FOLDER_MEMBER))
    return `${repositories(count)}, including the group folder. Kybern leaves the other repositories’ folders out of its snapshots.`;
  return `${repositories(count)}. Each keeps its own branches, commits and pull requests.`;
}

/** A member that can't be removed without dropping below the minimum. */
export const canRemoveMember = (memberCount: number): boolean => memberCount > GROUP_MIN_MEMBERS;

/** "3 uncommitted files stay in your checkout". */
export function uncommittedHint(dirtyFiles: number): string | null {
  if (dirtyFiles <= 0) return null;
  return `${dirtyFiles} uncommitted ${plural(dirtyFiles, "file stays", "files stay")} in your checkout`;
}

/** "Not found in ~/work/acme". */
export const memberMissingLabel = (folder: string): string => `Not found in ${folder}`;

/** "web isn’t in ~/work/acme anymore. Locate it or remove it from the group." */
export const memberMissingError = (name: string, folder: string): string =>
  `${name} isn’t in ${folder} anymore. Locate it or remove it from the group.`;

/** "web isn’t a git repository anymore. Remove it or pick another folder." */
export const memberNotGitError = (name: string): string => `${name} isn’t a git repository anymore. Remove it or pick another folder.`;

/** Repositories menu footer when some are unticked; one unticked repository names its checkout. */
export function deselectedNote(deselected: readonly MemberLike[], checkoutOf: (member: MemberLike) => string): string {
  if (deselected.length === 1) {
    const [member] = deselected;
    return `${member.name} stays out of this chat’s worktree. The agent can read your checkout at ${checkoutOf(member)} but not change it.`;
  }
  return GROUP_COPY.reposMenuFooter;
}

/** Worktree branch menu caption: "This chat works on kybern/01a16b… in every repository it uses." */
export const worktreeBranchCaption = (branch: string): string => `This chat works on ${branch} in every repository it uses.`;

/** Preparing line while worktrees are created (`threads.workspace_progress`): "Preparing worktrees… 2 of 3" counts finished ones. */
export function workspaceProgressLabel(progress: Pick<ThreadsWorkspaceProgress, "done" | "total">): string {
  if (progress.total <= 1) return "Preparing worktree…";
  return `Preparing worktrees… ${Math.min(progress.done, progress.total)} of ${progress.total}`;
}

// ---- diffs and pull requests ----

export interface RepoFileGroup<M extends MemberLike = MemberLike> {
  repo: M;
  /** Sorted by path. Paths stay relative to the thread cwd; use `stripRepoPrefix` to show them. */
  files: FileChange[];
  additions: number;
  deletions: number;
}

/**
 * Files grouped under one header per member, in member order (primary first),
 * including members with no changes so the user sees what the chat spans.
 * Files no member claims land in a final "Other files" group, never hidden.
 */
export function groupFilesByRepo<M extends MemberLike>(diff: Pick<Diff, "files">, members: readonly M[]): RepoFileGroup<M | MemberLike>[] {
  const groups = new Map<string, RepoFileGroup<M | MemberLike>>();
  for (const member of members) groups.set(member.path, { repo: member, files: [], additions: 0, deletions: 0 });
  let other: RepoFileGroup<MemberLike> | null = null;
  for (const file of diff.files) {
    const owner = file.repo != null ? members.find((member) => member.path === file.repo) : memberForPath(file.path, members);
    let group = owner ? groups.get(owner.path) : undefined;
    if (!group) group = other ??= { repo: { path: "", name: GROUP_COPY.otherFiles }, files: [], additions: 0, deletions: 0 };
    group.files.push(file);
    group.additions += file.additions;
    group.deletions += file.deletions;
  }
  const result = [...groups.values()];
  if (other) result.push(other);
  for (const group of result) group.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return result;
}

/** Transcript card title: "Edited 6 files in 2 repositories", or "Edited 3 files in api" for one. */
export function editedFilesTitle(fileCount: number, repoNames: readonly string[]): string {
  if (repoNames.length === 1) return `Edited ${files(fileCount)} in ${repoNames[0]}`;
  return `Edited ${files(fileCount)} in ${repositories(repoNames.length)}`;
}

/** Commit and push detail: "6 in 2 repos". */
export const commitDetail = (fileCount: number, repoCount: number): string => `${fileCount} in ${repos(repoCount)}`;

/** The create button: "Create 2 pull requests", or "Create pull request" for one. */
export function prButtonLabel(count: number): string {
  return count === 1 ? "Create pull request" : `Create ${count} pull requests`;
}

/**
 * Caption under the create button: which repositories get a pull request and
 * which are left out ("No changes", "No GitHub remote"), named so nothing is silent.
 */
export function prCaption(changed: readonly string[], unchanged: readonly string[], noRemote: readonly string[] = []): string {
  const parts: string[] = [];
  if (changed.length === 1) parts.push(`One in ${changed[0]}.`);
  else if (changed.length > 1)
    parts.push(`One in each changed repository (${joinNames(changed)}), each linking to the ${changed.length === 2 ? "other" : "others"}.`);
  if (noRemote.length) parts.push(`${joinNames(noRemote)} ${plural(noRemote.length, "has", "have")} no GitHub remote, so ${plural(noRemote.length, "it’s", "they’re")} skipped.`);
  if (unchanged.length) parts.push(`${joinNames(unchanged)} ${plural(unchanged.length, "has", "have")} no changes.`);
  return parts.join(" ");
}

/** Toast after `github.pr.create_group`: "2 pull requests opened" or "Opened 1 of 2 pull requests. web: No GitHub remote". */
export function prResultToast(created: number, skipped: readonly { path: string; reason: string }[]): string {
  const total = created + skipped.length;
  if (!skipped.length) return created === 1 ? "Pull request opened" : `${created} pull requests opened`;
  const reasons = skipped.map((item) => `${item.path}: ${item.reason}`).join("; ");
  return `Opened ${created} of ${total} pull requests. ${reasons}`;
}

/** Quiet warning row after a turn: "infra changed outside this chat’s worktree". */
export function outsideChangeText(names: readonly string[]): string {
  return `${joinNames(names)} changed outside this chat’s worktree`;
}

// ---- instruction files ----

/** "Created AGENTS.md and CLAUDE.md in acme. New chats use them." */
export function instructionsCreatedText(created: readonly string[], folderName: string): string {
  return `Created ${joinNames(created)} in ${folderName}. New chats use them.`;
}

/** Offer body naming the missing files and the members. */
export function instructionsOfferBody(folderName: string, memberNames: readonly string[], missing: readonly string[], folderIsGit: boolean): string {
  if (folderIsGit)
    return missing.length === 1
      ? `${folderName} is a git repository too, so ${missing[0]} will show up there as a new, uncommitted file. Commit it or add it to .gitignore afterwards.`
      : `${folderName} is a git repository too, so the two files will show up there as new, uncommitted files. Commit them or add them to .gitignore afterwards.`;
  const which = missing.length === 1 ? missing[0] : "both";
  return `Agents start in ${folderName}, so they read its AGENTS.md and CLAUDE.md, not the ones inside each repository. Kybern can create ${which}, listing ${joinNames(memberNames)} and telling agents to read each repository’s own instructions first.`;
}

/**
 * The files "Create files" will write, for the offer's Preview: the daemon's template (L3 spec §2.4) with the members
 * known now. `instructions` is each member's own file relative to the group folder (`api/AGENTS.md`), when it has one.
 * Kybern never edits these files after creating them.
 */
export function instructionsPreview(
  projectName: string,
  members: readonly { path: string; instructions?: string | null }[],
  folderIsGit: boolean,
): { agents: string; claude: string } {
  const listed = members.filter((member) => member.path !== GROUP_FOLDER_MEMBER);
  const lines = [
    `# ${projectName}`,
    "",
    folderIsGit
      ? "This folder is a git repository, and it also contains separate repositories nested inside it. Each has its own history, branches and pull requests."
      : "This folder groups separate git repositories. Each has its own history, branches and pull requests.",
    "",
    ...listed.map((member) => (member.instructions ? `- \`${member.path}/\`: instructions in \`${member.instructions}\`` : `- \`${member.path}/\`: no instructions file`)),
    "",
    "Before you edit files in a repository, read its instructions file.",
    folderIsGit ? "Run git inside the repository you changed." : "Run git inside the repository you changed; this folder is not a repository.",
    "A change across repositories needs a commit in each of them.",
  ];
  return { agents: `${lines.join("\n")}\n`, claude: "@AGENTS.md\n" };
}

/** "AGENTS.md already exists in acme. Open it to edit." */
export const instructionsExistError = (file: string, folderName: string): string => `${file} already exists in ${folderName}. Open it to edit.`;

// ---- copy ----

export const GROUP_COPY = {
  // Add menu and palette
  addMenuRepository: "Repository…",
  addMenuRepositoryDetail: "One folder, usually one git repository.",
  addMenuGroup: "Group of repositories…",
  addMenuGroupDetail: "A parent folder with several git repositories inside. Agents see all of them.",
  paletteAddProject: "Add project…",
  paletteAddGroup: "Add group of repositories…",
  paletteEditRepositories: "Edit repositories…",
  chooseGroupFolder: "Choose the group folder",
  // New group sheet
  newGroupTitle: "New group project",
  newGroupSubtitle: "Agents work in the group folder and can change any repository you select.",
  newGroupSubtitleMobile: "Choose a folder that holds several git repositories. Agents work in it and can change the ones you select.",
  groupFolder: "Group folder",
  change: "Change…",
  browse: "Browse",
  name: "Name",
  repositories: "Repositories",
  addFolder: "Add folder…",
  added: "Added",
  groupFolderItself: "the group folder itself",
  cancel: "Cancel",
  addGroup: "Add group",
  adding: "Adding…",
  scanning: (folderName: string) => `Looking for git repositories in ${folderName}…`,
  submoduleOf: (parent: string) => `Submodule of ${parent}`,
  nothingFoundTitle: (folderName: string) => `No git repositories in ${folderName}`,
  nothingFoundBody: "Kybern looked two folders deep. Add a deeper folder, or pick another group folder.",
  outsideFolderError: (folderName: string) => `Pick a folder inside ${folderName}. Folders outside the group can’t be added yet.`,
  alreadyProject: (folderName: string) => `${folderName} is already a project.`,
  openIt: "Open it",
  // Sidebar
  repositoriesMenuItem: "Repositories…",
  // Repositories dialog
  primary: "Primary",
  addRepositories: "Add repositories…",
  membersNote: "Existing chats keep the repositories they started with. A removed repository’s worktrees stay until those chats are archived.",
  revealInFinder: "Reveal in Finder",
  addAsOwnProject: "Add to projects as its own…",
  removeFromGroup: "Remove from group",
  minimumReason: "A group needs at least 2 repositories.",
  removed: (name: string) => `Removed ${name} from the group.`,
  undo: "Undo",
  locate: "Locate…",
  done: "Done",
  addRepositoriesTitle: (projectName: string) => `Add repositories to ${projectName}`,
  addRepositoriesBody: (folder: string) => `Repositories in ${folder} that aren’t in the group yet. New chats get them; existing chats don’t.`,
  addRepositoriesButton: (count: number) => `Add ${repositories(count)}`,
  sharedInstructions: "Shared instructions",
  notSetUp: "Not set up",
  notSetUpDetail: (folderName: string) => `Agents start in ${folderName} and read its AGENTS.md and CLAUDE.md.`,
  createFiles: "Create files",
  createFilesEllipsis: "Create files…",
  creating: "Creating…",
  openAgentsMd: "Open AGENTS.md",
  alsoCopy: "Also copy into worktrees",
  alsoCopyDetail: (folderName: string) => `Copied from ${folderName} into each new worktree, after AGENTS.md, CLAUDE.md and .claude/. Nothing is linked.`,
  alsoCopyAdd: "Add files…",
  alsoCopyEmpty: "Nothing else is copied.",
  // Instruction offer
  instructionsOfferTitle: "Add shared instructions for this group?",
  preview: "Preview",
  hidePreview: "Hide preview",
  notNow: "Not now",
  newFile: "new",
  // Composer tray
  branchMenuTitle: "Branch",
  branchMenuLocalCaption: "Switching a branch here checks it out in that repository.",
  branchMenuWorktreeTitle: "Fork the worktree from",
  newBranch: "New branch…",
  reposMenuTitle: "Repositories in this chat",
  reposMenuFooter: "Unticked repositories stay out of this chat’s worktree. The agent can still read your checkout of them.",
  lastRepository: "A chat needs at least one repository.",
  // Diff, environment and pull requests
  noChanges: "No changes",
  noRemote: "No remote",
  otherFiles: "Other files",
  openAll: "Open all",
  pullRequests: "Pull requests",
  // Transcript
  outsideChangeOpen: "Open",
} as const;
