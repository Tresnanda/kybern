import assert from "node:assert/strict";
import test from "node:test";
import {
  baseBranchesSummary,
  candidateDetail,
  emptyGroupDraft,
  groupCreateFields,
  includedPaths,
  isLastIncluded,
  prPlan,
  repoPullRows,
  supportsWorktree,
  toggleCandidate,
  toggleCopyEntry,
  toggleIncluded,
  versionAtLeast,
} from "../src/state/groups.ts";

const group = {
  id: "p1",
  is_git: false,
  kind: "group",
  members: [
    { path: "api", name: "api", status: "ok" },
    { path: "web", name: "web", status: "ok" },
    { path: "infra", name: "infra", status: "ok" },
    { path: "docs", name: "docs", status: "missing" },
  ],
};
const single = { id: "p2", is_git: true };
const draft = (patch = {}) => ({ ...emptyGroupDraft, groupProjectId: "p1", ...patch });

test("group UI needs a 0.15.0 daemon", () => {
  assert.equal(versionAtLeast("0.15.0"), true);
  assert.equal(versionAtLeast("v0.16.2"), true);
  assert.equal(versionAtLeast("0.15.0-dev"), true);
  assert.equal(versionAtLeast("0.14.9"), false);
  assert.equal(versionAtLeast(undefined), false);
});

test("group projects support worktrees even when the folder is not a repository", () => {
  assert.equal(supportsWorktree(group), true);
  assert.equal(supportsWorktree(single), true);
  assert.equal(supportsWorktree({ id: "p3", is_git: false }), false);
});

test("a worktree chat includes every present member by default and sends no member list", () => {
  assert.deepEqual(includedPaths(group, draft()), ["api", "web", "infra"]);
  assert.deepEqual(groupCreateFields(group, draft(), true), {});
  assert.deepEqual(groupCreateFields(single, draft({ members: ["api"] }), true), {});
});

test("choices made for another project are ignored", () => {
  const other = draft({ groupProjectId: "elsewhere", members: ["api"], baseBranches: { api: "dev" } });
  assert.deepEqual(groupCreateFields(group, other, true), {});
});

test("the last included repository can't be unticked", () => {
  let state = draft();
  state = { ...state, members: toggleIncluded(group, state, "infra") };
  assert.deepEqual(state.members, ["api", "web"]);
  state = { ...state, members: toggleIncluded(group, state, "web") };
  assert.deepEqual(state.members, ["api"]);
  assert.equal(isLastIncluded(group, state, "api"), true);
  assert.deepEqual(toggleIncluded(group, state, "api"), ["api"]);
  // Ticking everything again goes back to "all", so new members join later chats.
  state = { ...state, members: toggleIncluded(group, state, "web") };
  state = { ...state, members: toggleIncluded(group, state, "infra") };
  assert.equal(state.members, null);
});

test("create params carry members in worktree mode and base branches for the members in use", () => {
  const state = draft({ members: ["api", "web"], baseBranches: { api: "main", infra: "release", web: " " } });
  assert.deepEqual(groupCreateFields(group, state, true), { members: ["api", "web"], base_branches: { api: "main" } });
  // Local mode works in the group folder with every member, so no member list.
  assert.deepEqual(groupCreateFields(group, state, false), { base_branches: { api: "main", infra: "release" } });
});

test("base branches summary shows the primary plus the others", () => {
  assert.equal(baseBranchesSummary(["api", "web", "infra"], {}, { api: "main" }), "main +2");
  assert.equal(baseBranchesSummary(["api"], { api: "dev" }, { api: "main" }), "dev");
  assert.equal(baseBranchesSummary([], {}, {}), "Current branches");
});

test("checklist rows name nested paths and detached heads", () => {
  assert.equal(candidateDetail({ path: "services/billing", name: "billing", branch: "main" }), "services/billing · main");
  assert.equal(candidateDetail({ path: "api", name: "api", branch: "a1b2c3d", detached: true }), "a1b2c3d (detached)");
  assert.equal(candidateDetail({ path: ".", name: "acme", branch: "main" }), "main");
});

test("candidate and copy toggles keep a stable order", () => {
  assert.deepEqual(toggleCandidate(["web"], "."), [".", "web"]);
  assert.deepEqual(toggleCandidate([".", "web"], "web"), ["."]);
  assert.deepEqual(toggleCopyEntry(["scripts"], "Makefile"), ["Makefile", "scripts"]);
  assert.deepEqual(toggleCopyEntry(["Makefile", "scripts"], "Makefile"), ["scripts"]);
});

const pr = (number, patch = {}) => ({ number, title: `PR ${number}`, url: `https://x/${number}`, state: "OPEN", head: "h", base: "main", is_draft: false, author: "a", updated_at: "", ...patch });

test("pull request rows link to the other repositories", () => {
  const rows = repoPullRows([
    { repo: "api", name: "api", pull_request: pr(128) },
    { repo: "web", name: "web", pull_request: pr(77, { is_draft: true }) },
    { repo: "infra", name: "infra", pull_request: null },
  ]);
  assert.deepEqual(rows.map((row) => row.detail), ["Open · links to web #77", "Draft · links to api #128"]);
  assert.equal(repoPullRows([{ repo: "api", name: "api", pull_request: pr(1) }])[0].detail, "Open");
});

test("create plan skips unchanged repositories and ones without a remote", () => {
  const plan = prPlan(
    [
      { repo: "api", name: "api", included: true, remote_url: "git@github.com:a/api.git" },
      { repo: "web", name: "web", included: true, remote_url: null },
      { repo: "infra", name: "infra", included: true, remote_url: "x" },
      { repo: "docs", name: "docs", included: false, remote_url: "x" },
      { repo: "ops", name: "ops", included: true, remote_url: "x", pull_request: pr(3) },
    ],
    new Set(["api", "web", "ops"]),
  );
  assert.deepEqual(plan, { create: ["api"], unchanged: ["infra"], noRemote: ["web"] });
  // The daemon skips a remote off github.com, so the plan names it instead of promising a pull request.
  const gitlab = prPlan([{ repo: "web", name: "web", included: true, remote_url: "git@gitlab.com:a/web.git" }], new Set(["web"]));
  assert.deepEqual(gitlab, { create: [], unchanged: [], noRemote: ["web"] });
});
