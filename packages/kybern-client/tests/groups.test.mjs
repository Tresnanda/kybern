import test from "node:test";
import assert from "node:assert/strict";
import {
  GROUP_COPY,
  branchChipLabel,
  changedReposLabel,
  editedFilesTitle,
  groupFilesByRepo,
  includedMembers,
  instructionsOfferBody,
  isGroupProject,
  isGroupThread,
  memberForPath,
  memberSelectionError,
  memberSelectionHelper,
  orderMemberPaths,
  outsideChangeText,
  prButtonLabel,
  prCaption,
  prResultToast,
  primaryMember,
  repoBadge,
  reposChipLabel,
  stripRepoPrefix,
  uncommittedHint,
  workspaceProgressLabel,
} from "../src/groups.ts";
import { applyEvent, emptyThreadState, groupTurns, seedFromGet } from "../src/transcript.ts";

const member = (path, name = path) => ({ path, name, status: "ok" });
const file = (path, repo, additions = 1, deletions = 0) => ({ path, status: "modified", additions, deletions, binary: false, ...(repo ? { repo } : {}) });

test("kind and primary follow the daemon's order", () => {
  assert.equal(isGroupProject({ kind: "group" }), true);
  assert.equal(isGroupProject({}), false);
  assert.equal(isGroupProject(null), false);
  assert.equal(isGroupThread({ members: [] }), false);
  assert.equal(isGroupThread({ members: [{}] }), true);
  assert.deepEqual(orderMemberPaths(["web", "api", ".", "services/billing", "api"]), [".", "api", "services/billing", "web"]);
  assert.equal(primaryMember({ members: [member("."), member("api")] })?.path, ".");
  assert.equal(primaryMember({}), undefined);
  assert.deepEqual(
    includedMembers([{ path: "api", included: true }, { path: "web", included: false }, { path: "infra", included: true, missing: true }]).map((m) => m.path),
    ["api"],
  );
});

test("labels match the mockups", () => {
  assert.equal(repoBadge(3), "3 repos");
  assert.equal(repoBadge(12), "12 repos");
  assert.deepEqual(branchChipLabel("main", 2), { label: "main", extra: "+2" });
  assert.deepEqual(branchChipLabel("main", 0), { label: "main" });
  assert.equal(reposChipLabel(["api", "web", "infra"], 3), "3 repos");
  assert.equal(reposChipLabel(["api", "web"], 3), "2 of 3 repos");
  assert.equal(reposChipLabel(["api"], 3), "api only");
  assert.equal(changedReposLabel(2, 3), "2 of 3 repos");
  assert.equal(changedReposLabel(3, 3), "3 repos");
  assert.equal(uncommittedHint(3), "3 uncommitted files stay in your checkout");
  assert.equal(uncommittedHint(1), "1 uncommitted file stays in your checkout");
  assert.equal(uncommittedHint(0), null);
  assert.equal(workspaceProgressLabel({ done: 2, total: 3 }), "Preparing worktrees… 2 of 3");
  assert.equal(workspaceProgressLabel({ done: 0, total: 1 }), "Preparing worktree…");
  assert.equal(editedFilesTitle(6, ["api", "web"]), "Edited 6 files in 2 repositories");
  assert.equal(editedFilesTitle(1, ["api"]), "Edited 1 file in api");
  assert.equal(outsideChangeText(["infra"]), "infra changed outside this chat’s worktree");
  assert.equal(outsideChangeText(["docs", "infra"]), "docs and infra changed outside this chat’s worktree");
  assert.equal(GROUP_COPY.addRepositoriesButton(1), "Add 1 repository");
});

test("checklist validation counts the group folder as one member", () => {
  assert.equal(memberSelectionError([]), "Select at least 2 repositories.");
  assert.equal(memberSelectionError(["web"]), "Select 1 more repository.");
  assert.equal(memberSelectionError(["api", "api"]), "Select 1 more repository.");
  assert.equal(memberSelectionError([".", "api"]), null);
  assert.equal(memberSelectionHelper(["api", "web", "infra"]), "3 repositories. Each keeps its own branches, commits and pull requests.");
  assert.equal(
    memberSelectionHelper([".", "api"]),
    "2 repositories, including the group folder. Kybern leaves the other repositories’ folders out of its snapshots.",
  );
  assert.equal(memberSelectionHelper([]), "Select at least 2 repositories.");
});

test("files group by repository in member order, unchanged members included", () => {
  const members = [member("api"), member("web"), member("infra")];
  const groups = groupFilesByRepo(
    { files: [file("web/src/b.tsx", "web", 31), file("api/src/sso.rs", "api", 42, 3), file("api/Cargo.toml", "api", 1), file("web/src/a.tsx", undefined, 6, 4)] },
    members,
  );
  assert.deepEqual(groups.map((g) => g.repo.path), ["api", "web", "infra"]);
  assert.deepEqual(groups[0].files.map((f) => f.path), ["api/Cargo.toml", "api/src/sso.rs"]);
  assert.deepEqual([groups[0].additions, groups[0].deletions], [43, 3]);
  assert.deepEqual(groups[1].files.map((f) => f.path), ["web/src/a.tsx", "web/src/b.tsx"]);
  assert.equal(groups[2].files.length, 0);

  const stray = groupFilesByRepo({ files: [file("README.md")] }, members);
  assert.equal(stray.at(-1).repo.name, GROUP_COPY.otherFiles);
  assert.equal(stray.at(-1).files.length, 1);
});

test("paths resolve to the deepest member, with the group folder as the fallback", () => {
  const members = [member("."), member("api"), member("services/billing", "billing")];
  assert.equal(memberForPath("services/billing/src/x.rs", members)?.path, "services/billing");
  assert.equal(memberForPath("api/src/x.rs", members)?.path, "api");
  assert.equal(memberForPath("apiary/x", members)?.path, ".");
  assert.equal(memberForPath("x", [member("api")]), undefined);
  assert.equal(stripRepoPrefix("api/src/x.rs", "api"), "src/x.rs");
  assert.equal(stripRepoPrefix("README.md", "."), "README.md");
  assert.equal(stripRepoPrefix("web/x", "api"), "web/x");
});

test("pull request button, caption and toast name every repository", () => {
  assert.equal(prButtonLabel(2), "Create 2 pull requests");
  assert.equal(prButtonLabel(1), "Create pull request");
  assert.equal(prCaption(["api", "web"], ["infra"]), "One in each changed repository (api and web), each linking to the other. infra has no changes.");
  assert.equal(prCaption(["api"], [], ["web"]), "One in api. web has no GitHub remote, so it’s skipped.");
  assert.equal(prResultToast(2, []), "2 pull requests opened");
  assert.equal(prResultToast(1, [{ path: "web", reason: "No GitHub remote" }]), "Opened 1 of 2 pull requests. web: No GitHub remote");
});

test("instruction offer copy changes when the group folder is a repository", () => {
  assert.match(instructionsOfferBody("acme", ["api", "web", "infra"], ["AGENTS.md", "CLAUDE.md"], false), /Kybern can create both, listing api, web and infra/);
  assert.match(instructionsOfferBody("acme", ["api", "web"], ["AGENTS.md", "CLAUDE.md"], true), /^acme is a git repository too, so the two files/);
});

test("an outside change after a turn becomes a row of that turn, live and from a snapshot", () => {
  const thread = { id: "t", project_id: "p", title: "", provider: { kind: "claude-code" }, permission_mode: "supervised", status: "idle", cwd: "/c", pinned: false, created_at: "", updated_at: "", last_seq: 0 };
  const repos = [{ repo: "infra", name: "infra", source_path: "/work/acme/infra", dirty_files: 2 }];
  let state = emptyThreadState();
  state = applyEvent(state, { seq: 1, thread_id: "t", turn_id: "turn", at: "2026-10-24T00:00:00Z", kind: "turn_started", message_id: "m", message: { parts: [{ type: "text", text: "hi" }] } });
  state = applyEvent(state, { seq: 2, thread_id: "t", at: "2026-10-24T00:00:01Z", kind: "outside_repo_changed", repos });
  const [group] = groupTurns(state.blocks);
  assert.equal(group.outside?.length, 1);
  assert.deepEqual(group.outside[0].repos, repos);
  assert.equal(group.work.some((block) => block.kind === "outside_repo_changed"), false);

  const seeded = seedFromGet({
    thread,
    transcript: [{ role: "outside_repo_changed", turn_id: "turn", seq: 2, repos, at: "2026-10-24T00:00:01Z" }],
    pending_approvals: [],
  });
  assert.equal(seeded.blocks.find((block) => block.kind === "outside_repo_changed")?.turnId, "turn");
});
