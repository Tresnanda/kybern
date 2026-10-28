import assert from "node:assert/strict";
import test from "node:test";
import {
  assessPullRequest,
  checkWord,
  cleanCheckName,
  formatDuration,
  groupChecks,
  readinessGroup,
  rowReason,
} from "../src/pullRequests.ts";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const ago = (seconds) => new Date(NOW - seconds * 1000).toISOString();

const pull = (over = {}) => ({
  number: 2860,
  title: "development -> staging",
  url: "https://github.com/o/r/pull/2860",
  state: "OPEN",
  head: "development",
  base: "staging",
  is_draft: false,
  author: "tresnanda",
  updated_at: ago(60),
  mergeable: "MERGEABLE",
  ...over,
});
const run = (over = {}) => ({ name: "lint", status: "COMPLETED", conclusion: "SUCCESS", url: "https://example.test/1", ...over });
const running = (name = "lint", over = {}) => run({ name, status: "IN_PROGRESS", conclusion: "", ...over });
const failed = (name = "lint", over = {}) => run({ name, conclusion: "FAILURE", ...over });
const viewer = (over = {}) => ({
  can_merge: true,
  can_merge_as_admin: false,
  can_update_branch: true,
  can_enable_auto_merge: true,
  can_disable_auto_merge: true,
  can_mark_ready: true,
  merge_methods: ["squash", "merge", "rebase"],
  ...over,
});
const detail = (over = {}) => {
  const { pr, ...rest } = over;
  return { pull_request: pull(pr), merge_state_status: "CLEAN", checks: [run()], viewer: viewer(), reviews: [], ...rest };
};
const assess = (over) => assessPullRequest(detail(over), NOW);

// ---- ready ----

test("a clean pull request with passing checks is ready and squashes by default", () => {
  const a = assess({ checks: [run({ name: "a" }), run({ name: "b" }), run({ name: "c" })] });
  assert.equal(a.tone, "ready");
  assert.equal(a.severity, "success");
  assert.equal(a.title, "Ready to merge");
  assert.equal(a.detail, "All 3 checks passed. Nothing blocks the merge.");
  assert.deepEqual(a.blockers, []);
  assert.equal(a.next, null);
  assert.deepEqual(a.primary, { kind: "merge", label: "Squash and merge", method: "squash" });
  assert.deepEqual(
    a.menu.map((m) => [m.kind, m.method, m.destructive ?? false]),
    [["merge", "merge", false], ["merge", "rebase", false], ["close", undefined, true]],
  );
  assert.equal(a.refetch, false);
});

test("skipped checks are named, no checks at all is still ready", () => {
  assert.equal(assess({ checks: [run(), run({ conclusion: "SKIPPED" }), run({ conclusion: "SKIPPED" })] }).detail, "1 passed · 2 skipped. Nothing blocks the merge.");
  assert.equal(assess({ checks: [] }).detail, "No checks reported. Nothing blocks the merge.");
  assert.equal(assess({ checks: [run()] }).detail, "The check passed. Nothing blocks the merge.");
});

test("the merge method follows what the repository allows", () => {
  const rebaseOnly = assess({ viewer: viewer({ merge_methods: ["rebase"] }) });
  assert.deepEqual(rebaseOnly.primary, { kind: "merge", label: "Rebase and merge", method: "rebase" });
  assert.deepEqual(rebaseOnly.menu.map((m) => m.kind), ["close"]);
  assert.deepEqual(assess({ viewer: viewer({ merge_methods: ["merge", "rebase"] }) }).primary, { kind: "merge", label: "Create merge commit", method: "merge" });
});

test("a viewer without write access cannot merge; an unknown viewer is offered the merge", () => {
  const a = assess({ viewer: viewer({ can_merge: false }) });
  assert.equal(a.tone, "ready");
  assert.deepEqual(a.primary, { kind: "none", label: "You can't merge here" });
  assert.equal(a.menu.some((m) => m.kind === "merge"), false);
  assert.equal(assess({ viewer: undefined }).primary.kind, "merge");
});

test("UNSTABLE with an optional failure beside required checks is ready, and says so", () => {
  const a = assess({
    merge_state_status: "UNSTABLE",
    checks: [run({ name: "build", is_required: true }), failed("flaky", { is_required: false }), running("preview", { is_required: false })],
  });
  assert.equal(a.tone, "ready");
  assert.equal(a.detail, "1 passed · 1 optional check failed · 1 optional check still running. Nothing blocks the merge.");
});

test("HAS_HOOKS counts as clean", () => {
  assert.equal(assess({ merge_state_status: "HAS_HOOKS" }).tone, "ready");
});

// ---- waiting ----

test("UNSTABLE with only pending checks is waiting, never failing", () => {
  const a = assess({
    merge_state_status: "UNSTABLE",
    checks: [run(), ...Array.from({ length: 5 }, (_, i) => run({ name: `skip${i}`, conclusion: "SKIPPED" })), ...Array.from({ length: 6 }, (_, i) => running(`job${i}`))],
  });
  assert.equal(a.tone, "waiting");
  assert.equal(a.severity, "warning");
  assert.equal(a.title, "Waiting on 6 checks");
  assert.equal(a.detail, "1 passed · 5 skipped. Nothing else blocks the merge.");
  assert.deepEqual(a.blockers, []);
  assert.equal(a.next, "turn on auto-merge so it squashes when the checks pass");
  assert.deepEqual(a.primary, { kind: "auto_merge", label: "Merge when ready", method: "squash" });
  assert.ok(!/fail/i.test(`${a.title} ${a.detail}`));
});

test("BLOCKED on required pending checks is waiting too", () => {
  const a = assess({ merge_state_status: "BLOCKED", checks: [running("build", { is_required: true }), run({ name: "docs", is_required: false })] });
  assert.equal(a.tone, "waiting");
  assert.equal(a.title, "Waiting on 1 check");
  assert.equal(a.next, "turn on auto-merge so it squashes when the check passes");
});

test("waiting estimates the time left from the shards that finished", () => {
  const a = assess({
    merge_state_status: "UNSTABLE",
    checks: [
      run({ name: "Tests (1/2)", workflow_name: "CI", started_at: ago(600), completed_at: ago(300) }), // took 5 min
      running("Tests (2/2)", { workflow_name: "CI", started_at: ago(120) }), // 3 min to go
    ],
  });
  assert.equal(a.tone, "waiting");
  assert.equal(a.detail, "1 passed · about 3 min left. Nothing else blocks the merge.");
  // No estimate when a running check has nothing finished beside it, or never started.
  assert.equal(assess({ merge_state_status: "UNSTABLE", checks: [running("a", { started_at: ago(10) })] }).detail, "Nothing else blocks the merge.");
  assert.equal(assess({ merge_state_status: "UNSTABLE", checks: [run({ workflow_name: "CI", started_at: ago(60), completed_at: ago(30) }), running("b", { workflow_name: "CI" })] }).detail, "1 passed. Nothing else blocks the merge.");
});

test("auto-merge cannot be offered when the viewer may not turn it on", () => {
  const a = assess({ merge_state_status: "UNSTABLE", checks: [running()], viewer: viewer({ can_enable_auto_merge: false }) });
  assert.equal(a.tone, "waiting");
  assert.equal(a.primary.kind, "none");
  assert.equal(a.next, null);
  assert.equal(a.menu.some((m) => m.kind === "auto_merge"), false);
});

test("other merge methods are offered for auto-merge", () => {
  const a = assess({ merge_state_status: "UNSTABLE", checks: [running()] });
  assert.deepEqual(a.menu.filter((m) => m.kind === "auto_merge").map((m) => [m.method, m.label]), [
    ["merge", "Merge when ready (create merge commit)"],
    ["rebase", "Merge when ready (rebase and merge)"],
  ]);
});

test("armed auto-merge is shown as on, with cancel as the action", () => {
  const a = assess({
    merge_state_status: "UNSTABLE",
    pr: { auto_merge: { enabled_by: "kevin", merge_method: "squash" } },
    checks: [running("a"), running("b")],
  });
  assert.equal(a.tone, "waiting");
  assert.equal(a.severity, "info");
  assert.equal(a.title, "Auto-merge is on");
  assert.equal(a.detail, "It will squash and merge when the 2 checks pass. Turned on by kevin.");
  assert.deepEqual(a.primary, { kind: "cancel_auto_merge", label: "Cancel auto-merge" });
  assert.equal(assess({ pr: { auto_merge: { merge_method: "rebase" } }, checks: [run()] }).detail, "It will rebase and merge as soon as GitHub allows it.");
  assert.equal(assess({ merge_state_status: "UNSTABLE", pr: { auto_merge: { merge_method: "squash" } }, checks: [running()], viewer: viewer({ can_disable_auto_merge: false }) }).primary.kind, "none");
});

test("armed auto-merge does not hide a conflict", () => {
  const a = assess({ merge_state_status: "DIRTY", pr: { mergeable: "CONFLICTING", auto_merge: { merge_method: "squash" } } });
  assert.equal(a.tone, "conflict");
  assert.equal(a.primary.kind, "resolve_in_conversation");
  assert.ok(a.menu.some((m) => m.kind === "cancel_auto_merge"));
});

// ---- blocked ----

test("failing checks are blockers; a failing check never reads as waiting", () => {
  const a = assess({ merge_state_status: "UNSTABLE", checks: [failed("a"), failed("b"), running("c"), run({ name: "d" })] });
  assert.equal(a.tone, "blocked");
  assert.equal(a.severity, "danger");
  assert.equal(a.title, "2 checks failed");
  assert.deepEqual(a.blockers.map((b) => [b.kind, b.label]), [["checks_failed", "2 checks failed"]]);
  assert.equal(a.detail, "1 passed · 1 still running. Resolve this before it can merge.");
  assert.equal(a.primary.kind, "none");
  assert.equal(a.next, "fix the failing checks, or ask an agent to");
});

test("cancelled and timed-out checks block too", () => {
  for (const conclusion of ["CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]) {
    assert.equal(assess({ merge_state_status: "UNSTABLE", checks: [run({ conclusion })] }).tone, "blocked", conclusion);
  }
});

test("without any required check marked, every failure blocks; once some are required, optional failures do not", () => {
  assert.equal(assess({ merge_state_status: "UNSTABLE", checks: [failed("a", { is_required: false })] }).tone, "blocked");
  assert.equal(assess({ merge_state_status: "UNSTABLE", checks: [failed("a", { is_required: false }), run({ name: "b", is_required: true })] }).tone, "ready");
  assert.equal(assess({ merge_state_status: "BLOCKED", checks: [failed("a", { is_required: true })] }).tone, "blocked");
});

test("BLOCKED by required reviews offers Merge anyway only to an admin", () => {
  const input = { merge_state_status: "BLOCKED", pr: { review_decision: "REVIEW_REQUIRED" }, checks: [run()] };
  const member = assess(input);
  assert.equal(member.tone, "blocked");
  assert.equal(member.severity, "warning");
  assert.equal(member.title, "Waiting on review");
  assert.deepEqual(member.blockers.map((b) => b.kind), ["review_required"]);
  assert.equal(member.primary.kind, "none");
  assert.equal(member.next, "ask a reviewer to approve");
  assert.equal(member.menu.some((m) => m.kind === "merge_admin"), false);

  const admin = assess({ ...input, viewer: viewer({ can_merge_as_admin: true }) });
  assert.equal(admin.next, "ask a reviewer to approve, or merge anyway as an admin");
  const anyway = admin.menu.find((m) => m.kind === "merge_admin");
  assert.deepEqual(anyway, { kind: "merge_admin", label: "Merge anyway", method: "squash", destructive: true });
  assert.equal(admin.menu.at(-1).kind, "close");
});

test("changes requested names who asked", () => {
  const a = assess({
    pr: { review_decision: "CHANGES_REQUESTED" },
    reviews: [{ login: "kevin", state: "CHANGES_REQUESTED" }, { login: "ana", state: "APPROVED" }],
  });
  assert.equal(a.tone, "blocked");
  assert.equal(a.title, "Changes requested");
  assert.equal(a.blockers[0].label, "Changes requested by kevin");
  assert.equal(a.next, "address the requested changes, then ask for another review");
});

test("BEHIND offers Update branch, with the number of commits when known", () => {
  const a = assess({ merge_state_status: "BEHIND", behind_by: 3 });
  assert.equal(a.tone, "blocked");
  assert.equal(a.severity, "warning");
  assert.equal(a.title, "Behind staging");
  assert.equal(a.blockers[0].label, "3 commits behind staging");
  assert.deepEqual(a.primary, { kind: "update_branch", label: "Update branch" });
  assert.equal(a.next, "update the branch to pick up the latest changes");
  assert.equal(assess({ merge_state_status: "BEHIND" }).blockers[0].label, "Behind staging");
  assert.equal(assess({ merge_state_status: "BEHIND", behind_by: 1 }).blockers[0].label, "1 commit behind staging");
});

test("BEHIND cannot be updated by a viewer who may not", () => {
  const a = assess({ merge_state_status: "BEHIND", viewer: viewer({ can_update_branch: false }) });
  assert.equal(a.primary.kind, "none");
  assert.equal(a.menu.some((m) => m.kind === "update_branch"), false);
});

test("behind and failing: update first, and the other blocker is listed", () => {
  const a = assess({ merge_state_status: "BEHIND", checks: [failed()] });
  assert.equal(a.title, "2 blockers");
  assert.deepEqual(a.blockers.map((b) => b.kind), ["behind", "checks_failed"]);
  assert.equal(a.primary.kind, "update_branch");
  assert.equal(a.detail, "Resolve these before it can merge.");
});

test("conflicts: DIRTY or CONFLICTING sends the problem to an agent and never offers Merge anyway", () => {
  for (const input of [{ merge_state_status: "DIRTY" }, { pr: { mergeable: "CONFLICTING" }, merge_state_status: "BLOCKED" }]) {
    const a = assess({ ...input, viewer: viewer({ can_merge_as_admin: true }) });
    assert.equal(a.tone, "conflict");
    assert.equal(a.severity, "danger");
    assert.equal(a.title, "Conflicts with staging");
    assert.deepEqual(a.primary, { kind: "resolve_in_conversation", label: "Resolve in conversation" });
    assert.equal(a.next, "have an agent resolve the conflicts in a conversation");
    assert.equal(a.menu.some((m) => m.kind === "merge_admin"), false);
  }
});

test("BLOCKED that nothing explains is a blocker, not ready", () => {
  const a = assess({ merge_state_status: "BLOCKED", checks: [run()] });
  assert.equal(a.tone, "blocked");
  assert.deepEqual(a.blockers.map((b) => b.kind), ["branch_protection"]);
  assert.equal(a.title, "Blocked by the branch rules");
});

// ---- unknown, draft, merged, closed ----

test("UNKNOWN, missing and stale mergeability is never ready", () => {
  for (const input of [
    { merge_state_status: "UNKNOWN" },
    { merge_state_status: undefined },
    { merge_state_status: "SOMETHING_NEW" },
    { merge_state_status: "UNSTABLE", checks: [run()] }, // UNSTABLE but nothing is failing or running
    { merge_state_status: "UNSTABLE", checks: [] },
  ]) {
    const a = assessPullRequest({ ...detail(input), merge_state_status: input.merge_state_status }, NOW);
    assert.equal(a.tone, "unknown", JSON.stringify(input));
    assert.equal(a.refetch, true);
    assert.equal(a.primary.kind, "none");
    assert.equal(a.severity, "neutral");
  }
});

test("known blockers still show while mergeability is unknown", () => {
  const a = assess({ merge_state_status: "UNKNOWN", pr: { review_decision: "CHANGES_REQUESTED" } });
  assert.equal(a.tone, "blocked");
  assert.equal(a.refetch, false);
});

test("a draft offers Ready for review, only to a viewer who may", () => {
  const a = assess({ pr: { is_draft: true }, merge_state_status: "DRAFT" });
  assert.equal(a.tone, "draft");
  assert.equal(a.title, "Draft");
  assert.deepEqual(a.primary, { kind: "ready_for_review", label: "Ready for review" });
  assert.equal(a.next, "mark it ready for review when it is done");
  assert.deepEqual(a.menu.map((m) => m.kind), ["close"]);
  assert.equal(assess({ pr: { is_draft: true }, viewer: viewer({ can_mark_ready: false }) }).primary.kind, "none");
  assert.equal(assess({ pr: { is_draft: true }, viewer: undefined }).primary.kind, "ready_for_review");
});

test("merged and closed pull requests have nothing to do", () => {
  const merged = assess({ pr: { state: "MERGED" }, merged_by: "kevin" });
  assert.equal(merged.tone, "merged");
  assert.equal(merged.title, "Merged into staging");
  assert.equal(merged.detail, "Merged by kevin.");
  assert.deepEqual([merged.primary.kind, merged.menu.length, merged.blockers.length], ["none", 0, 0]);
  const closed = assess({ pr: { state: "CLOSED" } });
  assert.equal(closed.tone, "closed");
  assert.equal(closed.title, "Closed without merging");
  assert.equal(closed.primary.kind, "none");
  // A merged draft or a merged pull request with failing checks is still merged.
  assert.equal(assess({ pr: { state: "MERGED", is_draft: true }, checks: [failed()] }).tone, "merged");
});

test("the summary on the pull request stands in when no individual checks were read", () => {
  const a = assessPullRequest(
    { pull_request: pull({ merge_state_status: "UNSTABLE", checks_summary: { total: 4, passed: 1, failed: 0, pending: 3, skipped: 0 } }) },
    NOW,
  );
  assert.equal(a.tone, "waiting");
  assert.equal(a.title, "Waiting on 3 checks");
  const failing = assessPullRequest({ pull_request: pull({ merge_state_status: "UNSTABLE", checks_summary: { total: 2, passed: 1, failed: 1, pending: 0, skipped: 0 } }) }, NOW);
  assert.equal(failing.tone, "blocked");
});

// ---- list rows ----

const row = (over = {}) => ({ state: "OPEN", is_draft: false, mergeable: "MERGEABLE", merge_state_status: "CLEAN", base: "staging", ...over });
const summary = (over = {}) => ({ total: 3, passed: 3, failed: 0, pending: 0, skipped: 0, ...over });

test("a row's reason is one short label with a tone", () => {
  assert.deepEqual(rowReason(row({ checks_summary: summary({ failed: 2, passed: 1 }) })), { label: "2 failing", tone: "danger" });
  assert.deepEqual(rowReason(row({ review_decision: "CHANGES_REQUESTED" })), { label: "Changes requested", tone: "danger" });
  assert.deepEqual(rowReason(row({ mergeable: "CONFLICTING", merge_state_status: "DIRTY" })), { label: "Conflicts", tone: "danger" });
  assert.deepEqual(rowReason(row({ merge_state_status: "BEHIND" })), { label: "Behind", tone: "warning" });
  assert.deepEqual(rowReason(row({ merge_state_status: "UNSTABLE", checks_summary: summary({ pending: 6, passed: 1, total: 7 }) })), { label: "6 running", tone: "warning" });
  assert.deepEqual(rowReason(row({ merge_state_status: "BLOCKED", review_decision: "REVIEW_REQUIRED" })), { label: "Needs review", tone: "neutral" });
  assert.deepEqual(rowReason(row({ review_decision: "APPROVED" })), { label: "Ready", tone: "success" });
  assert.deepEqual(rowReason(row({ review_decision: "APPROVED", merge_state_status: "UNKNOWN" })), { label: "Approved", tone: "success" });
  assert.deepEqual(rowReason(row({ review_decision: "APPROVED", merge_state_status: "BLOCKED" })), { label: "Blocked", tone: "warning" });
  assert.deepEqual(rowReason(row({ is_draft: true })), { label: "Draft", tone: "neutral" });
  assert.deepEqual(rowReason(row({ auto_merge: { merge_method: "squash" }, checks_summary: summary({ pending: 1, passed: 2 }) })), { label: "Auto-merge on", tone: "info" });
  assert.deepEqual(rowReason(row({ state: "MERGED" })), { label: "Merged", tone: "neutral" });
  assert.deepEqual(rowReason(row({ merge_state_status: "UNKNOWN" })), { label: "Open", tone: "neutral" });
});

test("running checks are never counted as failing on a row", () => {
  const r = rowReason(row({ merge_state_status: "UNSTABLE", checks_summary: summary({ pending: 6, passed: 0, total: 6 }) }));
  assert.equal(r.label, "6 running");
  assert.notEqual(r.tone, "danger");
});

test("rows group by readiness", () => {
  assert.equal(readinessGroup(row({ is_draft: true })), "draft");
  assert.equal(readinessGroup(row({ checks_summary: summary({ failed: 1, passed: 2 }) })), "needs_attention");
  assert.equal(readinessGroup(row({ mergeable: "CONFLICTING" })), "needs_attention");
  assert.equal(readinessGroup(row({ review_decision: "CHANGES_REQUESTED" })), "needs_attention");
  assert.equal(readinessGroup(row({ merge_state_status: "BEHIND" })), "needs_attention");
  assert.equal(readinessGroup(row({ merge_state_status: "BLOCKED", review_decision: "REVIEW_REQUIRED" })), "awaiting_review");
  assert.equal(readinessGroup(row({ merge_state_status: "UNSTABLE", checks_summary: summary({ pending: 2, passed: 1 }) })), "awaiting_review");
  assert.equal(readinessGroup(row({ review_decision: "APPROVED" })), "approved");
  assert.equal(readinessGroup(row({ review_decision: "APPROVED", checks_summary: summary({ pending: 1, passed: 2 }), merge_state_status: "UNSTABLE" })), "approved");
  assert.equal(readinessGroup(row()), "approved", "no required review and nothing wrong");
  assert.equal(readinessGroup(row({ merge_state_status: "UNKNOWN" })), "awaiting_review");
  assert.equal(readinessGroup(row({ state: "MERGED" })), null);
  assert.equal(readinessGroup(row({ state: "CLOSED" })), null);
});

// ---- checks ----

test("emoji are stripped from check names", () => {
  assert.equal(cleanCheckName("🧪 Tests (1/4)"), "Tests (1/4)");
  assert.equal(cleanCheckName("✅ lint ❤️‍🔥 build"), "lint build");
  assert.equal(cleanCheckName("🚀"), "🚀", "a name that is only an emoji stays");
  assert.equal(cleanCheckName("build / unit"), "build / unit");
});

test("check results keep their own words", () => {
  const word = (over) => checkWord(run(over));
  assert.equal(word({}), "Passed");
  assert.equal(word({ conclusion: "FAILURE" }), "Failed");
  assert.equal(word({ conclusion: "CANCELLED" }), "Cancelled");
  assert.equal(word({ conclusion: "TIMED_OUT" }), "Timed out");
  assert.equal(word({ conclusion: "ACTION_REQUIRED" }), "Needs action");
  assert.equal(word({ conclusion: "SKIPPED" }), "Skipped");
  assert.equal(word({ conclusion: "NEUTRAL" }), "Neutral");
  assert.equal(word({ status: "IN_PROGRESS", conclusion: "" }), "Running");
  assert.equal(word({ status: "QUEUED", conclusion: "" }), "Queued");
  assert.equal(checkWord({ name: "ci", status: "", conclusion: "PENDING", url: "" }), "Pending");
  assert.equal(checkWord({ name: "ci", status: "", conclusion: "ERROR", url: "" }), "Error");
});

test("durations read as minutes and seconds", () => {
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(192_000), "3m 12s");
  assert.equal(formatDuration(65_000), "1m 05s");
  assert.equal(formatDuration(3_840_000), "1h 04m");
  assert.equal(formatDuration(-5), "0s");
});

test("shards collapse into one row per job, ordered failed, running, passed, skipped", () => {
  const checks = [
    run({ name: "🧹 lint", workflow_name: "CI", started_at: ago(300), completed_at: ago(280) }),
    run({ name: "Tests (1/4)", workflow_name: "CI", is_required: true, started_at: ago(400), completed_at: ago(300) }),
    run({ name: "Tests (2/4)", workflow_name: "CI", is_required: true, started_at: ago(400), completed_at: ago(250) }),
    running("Tests (3/4)", { workflow_name: "CI", is_required: true, started_at: ago(200) }),
    running("Tests (4/4)", { workflow_name: "CI", is_required: true, started_at: ago(190) }),
    run({ name: "docs", conclusion: "SKIPPED" }),
    failed("e2e", { workflow_name: "E2E", started_at: ago(100), completed_at: ago(40) }),
  ];
  const groups = groupChecks(checks, NOW);
  assert.deepEqual(groups.map((g) => [g.label, g.bucket]), [["e2e", "failed"], ["Tests", "pending"], ["lint", "passed"], ["docs", "skipped"]]);
  const tests = groups[1];
  assert.equal(tests.checks.length, 4);
  assert.equal(tests.required, true);
  assert.equal(tests.detail, "shards 2/4 done");
  assert.equal(tests.elapsedMs, 400_000, "from the first start to now while any shard runs");
  assert.equal(tests.elapsed, "6m 40s");
  assert.equal(groups[0].detail, "Failed");
  assert.equal(groups[0].elapsed, "1m 00s");
  assert.equal(groups[0].required, false);
  assert.equal(groups[2].detail, "");
  assert.equal(groups[2].elapsed, "20s");
  assert.equal(groups[3].elapsed, "");
});

test("a finished sharded job runs from the first start to the last end, and names its failures", () => {
  const groups = groupChecks(
    [
      run({ name: "Tests (1/2)", workflow_name: "CI", started_at: ago(500), completed_at: ago(300) }),
      failed("Tests (2/2)", { workflow_name: "CI", started_at: ago(400), completed_at: ago(200), url: "https://example.test/fail" }),
    ],
    NOW,
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].bucket, "failed");
  assert.equal(groups[0].detail, "shards 2/2 done · 1 failed");
  assert.equal(groups[0].elapsedMs, 300_000);
  assert.equal(groups[0].url, "https://example.test/fail");
});

test("the same job name in two workflows stays two rows; order within a bucket is kept", () => {
  const groups = groupChecks([run({ name: "build", workflow_name: "A" }), run({ name: "build", workflow_name: "B" }), run({ name: "alpha", workflow_name: "A" })], NOW);
  assert.deepEqual(groups.map((g) => [g.workflow, g.label]), [["A", "build"], ["B", "build"], ["A", "alpha"]]);
});
