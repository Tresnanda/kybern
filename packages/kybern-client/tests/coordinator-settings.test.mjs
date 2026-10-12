import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanOverrides,
  defaultOverrideText,
  effectiveCoordinatorSettings,
  roleChip,
  roleDefaultLabel,
  settingValueLabel,
  withGlobalRoleDefault,
  withOverrideField,
  withRoleOverride,
} from "../src/coordinatorSettings.ts";
import {
  checksLabel,
  coordinatorCardLine,
  gitCardCopy,
  leadGitCardInput,
  settingsProposalInput,
  briefProposalInput,
  cardPartsText,
} from "../src/coordinatorCards.ts";
import { convertTypedSlashSkills } from "../src/composerTokens.ts";

const claude = { kind: "claude-code", provider: { kind: "claude-code", instance: "default" } };
const providers = [
  { kind: "claude-code", models: [{ id: "claude-opus-5-5", display_name: "Opus 5.5" }, { id: "claude-sonnet-5-5", display_name: "Sonnet 5.5" }] },
  { kind: "codex", models: [{ id: "gpt-5.5-codex", display_name: "GPT-5.5 Codex" }] },
];
const opus = { provider: claude.provider, model: "claude-opus-5-5", effort: "high" };
const sonnet = { provider: claude.provider, model: "claude-sonnet-5-5" };

test("the resolver takes the project, then Settings, then the built-in default", () => {
  const builtin = effectiveCoordinatorSettings(undefined, undefined);
  assert.deepEqual(builtin, { role_defaults: {}, lead_autonomy: "propose_large", lead_workspace: "shared", lead_push_without_asking: false, lead_max_children: 6 });
  const global = { max_active_children: 4, lead_max_children: 4, max_depth: 2, lead_autonomy: "propose_first", role_defaults: { research: sonnet, review: { model: "m" } } };
  const project = { lead_autonomy: "act", lead_push_without_asking: true, role_defaults: { research: opus } };
  const effective = effectiveCoordinatorSettings(global, project);
  assert.equal(effective.lead_autonomy, "act");
  assert.equal(effective.lead_max_children, 4);
  assert.equal(effective.lead_push_without_asking, true);
  assert.equal(effective.lead_workspace, "shared");
  assert.deepEqual(effective.role_defaults.research, opus, "a project role replaces the global entry");
  assert.deepEqual(effective.role_defaults.review, { model: "m" }, "other roles keep the global entry");
  assert.equal(effectiveCoordinatorSettings(global, null).lead_autonomy, "propose_first");
});

test("overrides are sent whole, without empty fields, and empty becomes null", () => {
  assert.equal(cleanOverrides({}), null);
  assert.equal(cleanOverrides({ role_defaults: { design: { model: "  " } } }), null);
  const one = withOverrideField(null, "lead_autonomy", "act");
  assert.deepEqual(one, { lead_autonomy: "act" });
  const two = withRoleOverride(one, "design", opus);
  assert.deepEqual(two, { lead_autonomy: "act", role_defaults: { design: opus } });
  const keepsFalse = withOverrideField(two, "lead_push_without_asking", false);
  assert.equal(keepsFalse.lead_push_without_asking, false, "false is a value, not a reset");
  assert.deepEqual(withRoleOverride(keepsFalse, "design", null), { lead_autonomy: "act", lead_push_without_asking: false });
  assert.equal(withOverrideField(withRoleOverride(one, "design", null), "lead_autonomy", null), null);
  const global = withGlobalRoleDefault({ max_active_children: 4, lead_max_children: 6, max_depth: 2 }, "test", sonnet);
  assert.deepEqual(global.role_defaults, { test: sonnet });
  assert.deepEqual(withGlobalRoleDefault(global, "test", null).role_defaults, {});
});

test("role chips say what is set, inherited, or left to the Coordinator", () => {
  const global = { role_defaults: { research: sonnet } };
  assert.deepEqual(roleChip("research", global, null, providers, "project"), { kind: "inherited", label: "Default · Sonnet 5.5", provider: claude.provider });
  assert.deepEqual(roleChip("review", global, { role_defaults: { review: opus } }, providers, "project"), { kind: "set", label: "Opus 5.5 · high", provider: claude.provider });
  assert.deepEqual(roleChip("design", global, null, providers, "project"), { kind: "coordinator", label: "Same as the Coordinator" });
  assert.equal(roleChip("research", global, undefined, providers, "global").label, "Sonnet 5.5");
  assert.equal(roleChip("test", global, undefined, providers, "global").label, "Same as the Coordinator");
  assert.equal(roleDefaultLabel({ provider: { kind: "codex", instance: "default" } }, providers), "Codex");
  assert.equal(roleDefaultLabel({ model: "unknown-model" }, providers), "unknown-model");
  assert.equal(roleDefaultLabel(null, providers), null);
});

test("proposal values read as the controls say them", () => {
  assert.equal(settingValueLabel("lead_autonomy", "propose_large", providers), "Propose large");
  assert.equal(settingValueLabel("lead_workspace", "worktree", providers), "Own worktree");
  assert.equal(settingValueLabel("role_defaults.design", null, providers), "Default");
  assert.equal(settingValueLabel("role_defaults.review", opus, providers), "Opus 5.5 · high");
  assert.equal(settingValueLabel("lead_push_without_asking", true, providers), "Without asking");
  assert.equal(settingValueLabel("lead_max_children", 3, providers), "3 agents");
  assert.equal(
    defaultOverrideText({ provider: claude.provider, model: "claude-sonnet-5-5", reason: "The crash repro needs deeper reasoning." }, providers),
    "Instead of the Sonnet 5.5 default: The crash repro needs deeper reasoning.",
  );
});

const card = (tool_name, input) => ({ tool_name, input });

test("cards read their inputs and settle into one line", () => {
  const brief = card("kybern_coordinator_brief", { text: "Kybern: small PRs.", replaces: false });
  assert.deepEqual(briefProposalInput(brief), { text: "Kybern: small PRs.", replaces: false });
  assert.equal(cardPartsText(coordinatorCardLine(brief, { decision: "submit", response: { text: "x" } })), "Saved the project brief");
  assert.equal(cardPartsText(coordinatorCardLine(brief, { decision: "deny" })), "Declined the project brief");
  assert.equal(cardPartsText(coordinatorCardLine(brief, null, false)), "Request ended: the Coordinator stopped before you answered");

  const settings = card("kybern_coordinator_settings", { reason: "r", changes: [
    { path: "lead_autonomy", label: "Before starting work", old: "act", new: "propose_large" },
    { path: "role_defaults.design", label: "Design model", old: null, new: opus },
    { path: "lead_workspace", label: "Agents work in", old: "shared", new: "worktree" },
    { label: "missing path" },
  ] });
  assert.equal(settingsProposalInput(settings).changes.length, 3);
  assert.equal(cardPartsText(coordinatorCardLine(settings, { decision: "submit", response: { accepted: ["lead_autonomy", "role_defaults.design"] } })), "Applied 2 Coordinator settings");
  assert.equal(cardPartsText(coordinatorCardLine(settings, { decision: "deny", reason: "timed out" })), "Request ended: no answer in time");

  const push = card("kybern_git", { op: "push", remote: "origin", branch: "fix/x", ahead: 3 });
  assert.deepEqual(leadGitCardInput(push), { op: "push", remote: "origin", branch: "fix/x", ahead: 3 });
  assert.equal(cardPartsText(gitCardCopy(leadGitCardInput(push)).title), "Push fix/x?");
  assert.equal(cardPartsText(coordinatorCardLine(push, { decision: "allow_once" })), "Pushed fix/x");
  const pr = card("kybern_git", { op: "open_pr", remote: "origin", branch: "fix/x", ahead: 1, title: "Fix", body: "b", base: "main" });
  assert.equal(cardPartsText(gitCardCopy(leadGitCardInput(pr)).detail), "1 commit ahead of main on origin.");
  assert.equal(cardPartsText(coordinatorCardLine(pr, { decision: "deny" })), "Declined opening a pull request for fix/x");
  const merge = card("kybern_git", { op: "merge_pr", number: 12, title: "Fix", checks: { total: 6, passed: 6, failed: 0, pending: 0, skipped: 0 }, method: "squash" });
  assert.equal(cardPartsText(gitCardCopy(leadGitCardInput(merge)).title), "Squash-merge PR #12?");
  assert.equal(cardPartsText(coordinatorCardLine(merge, { decision: "allow_once" })), "Merged PR #12");
  assert.deepEqual(checksLabel(leadGitCardInput(merge).checks), { text: "6 checks passed", tone: "ok" });
  assert.deepEqual(checksLabel({ total: 3, passed: 1, failed: 1, pending: 1, skipped: 0 }), { text: "1 check failing", tone: "bad" });
  assert.equal(checksLabel({ total: 0, passed: 0, failed: 0, pending: 0, skipped: 0 }), null);
  assert.equal(coordinatorCardLine(card("Bash", {}), null), null);
});

const skills = [
  { name: "review", path: "/skills/review", scope: "user", enabled: true },
  { name: "review-pr", path: "/skills/review-pr", scope: "project", enabled: true },
  { name: "off", path: "/skills/off", scope: "user", enabled: false },
  { name: "computer-use", path: "kybern://computer", scope: "plugin", enabled: true },
];

test("a typed /skill becomes its skill part and leaves the text", () => {
  assert.deepEqual(convertTypedSlashSkills([{ type: "text", text: "/review the sign-in flow" }], skills), [
    { type: "skill", name: "review", path: "/skills/review" },
    { type: "text", text: " the sign-in flow" },
  ]);
  assert.deepEqual(convertTypedSlashSkills([{ type: "text", text: "please /Review-PR, then ship" }], skills), [
    { type: "text", text: "please " },
    { type: "skill", name: "review-pr", path: "/skills/review-pr" },
    { type: "text", text: ", then ship" },
  ]);
  assert.deepEqual(convertTypedSlashSkills([{ type: "text", text: "/review" }], skills), [{ type: "skill", name: "review", path: "/skills/review" }]);
});

test("unknown slash words, paths, URLs, disabled skills and plugins stay text", () => {
  for (const text of ["/reviewer is not a skill", "see /usr/review/bin", "https://example.com/review", "a/review b", "/off now", "/computer-use", "/unknown"]) {
    assert.deepEqual(convertTypedSlashSkills([{ type: "text", text }], skills), [{ type: "text", text }], text);
  }
  const attachment = { type: "attachment", asset_id: "a", name: "x.png", media_type: "image/png", size: 1 };
  assert.deepEqual(convertTypedSlashSkills([{ type: "text", text: "look " }, attachment], skills), [{ type: "text", text: "look " }, attachment]);
});

test("only a standalone /name waits for the skill catalog, never a path", async () => {
  const { hasTypedSlashCandidate } = await import("../src/composerTokens.ts");
  for (const text of ["/review this", "please /grilling", "run /deploy.", "/qa"]) assert.equal(hasTypedSlashCandidate(text), true, text);
  for (const text of ["see /project/docs/routing.md", "/usr/bin/env", "a/b", "no slash", "open /tmp/"]) assert.equal(hasTypedSlashCandidate(text), false, text);
});
