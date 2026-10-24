import assert from "node:assert/strict";
import test from "node:test";
import {
  PR_STATE_WORDS,
  byUpdated,
  checksOutcome,
  emptyPrTitle,
  linkedRepairThread,
  matchesPrQuery,
  repairBlocked,
  repairChoices,
  resolvePrStateKind,
  reviewDecisionWord,
} from "../src/pullRequests.ts";
import { emptyReviewDraft, repairReviewPrompt, toggleReviewFinding } from "../src/prReview.ts";

const pr = { number: 42, title: "Fix login redirect", head: "fix/login", state: "OPEN", is_draft: false, mergeable: "MERGEABLE" };

test("a pull request reads as one state word", () => {
  assert.equal(PR_STATE_WORDS[resolvePrStateKind(pr)], "Open");
  assert.equal(PR_STATE_WORDS[resolvePrStateKind({ ...pr, is_draft: true })], "Draft");
  assert.equal(PR_STATE_WORDS[resolvePrStateKind({ ...pr, mergeable: "CONFLICTING" })], "Has conflicts");
  assert.equal(PR_STATE_WORDS[resolvePrStateKind({ ...pr, state: "MERGED", is_draft: true })], "Merged");
  assert.equal(reviewDecisionWord("CHANGES_REQUESTED"), "Changes requested");
  assert.equal(reviewDecisionWord(undefined), "");
});

test("checks collapse to the bucket that matters most", () => {
  assert.equal(checksOutcome({ total: 3, passed: 1, failed: 1, pending: 1, skipped: 0 }), "failed");
  assert.equal(checksOutcome({ total: 2, passed: 1, failed: 0, pending: 1, skipped: 0 }), "pending");
  assert.equal(checksOutcome({ total: 2, passed: 2, failed: 0, pending: 0, skipped: 0 }), "passed");
  assert.equal(checksOutcome({ total: 0, passed: 0, failed: 0, pending: 0, skipped: 0 }), null);
});

test("search matches title, branch and number; lists sort by activity", () => {
  assert.ok(matchesPrQuery(pr, "#42"));
  assert.ok(matchesPrQuery(pr, "LOGIN"));
  assert.ok(matchesPrQuery(pr, "fix/"));
  assert.ok(!matchesPrQuery(pr, "billing"));
  const rows = byUpdated([{ pr: { updated_at: "2026-10-01" } }, { pr: { updated_at: "2026-10-03" } }]);
  assert.equal(rows[0].pr.updated_at, "2026-10-03");
  assert.equal(emptyPrTitle("open"), "No open pull requests");
  assert.equal(emptyPrTitle("all"), "No pull requests");
});

test("checkout and repair use worktree conversations of the same project", () => {
  const threads = [
    { id: "a", project_id: "p", status: "idle", worktree: { branch: "fix/login" } },
    { id: "b", project_id: "p", status: "idle", worktree: null },
    { id: "c", project_id: "q", status: "idle", worktree: { branch: "fix/login" } },
    { id: "d", project_id: "p", status: "archived", worktree: { branch: "x" } },
    { id: "e", project_id: "p", status: "running", worktree: { branch: "y" }, delegation: { id: "z" } },
  ];
  assert.deepEqual(repairChoices(threads, "p").map((t) => t.id), ["a"]);
  assert.equal(linkedRepairThread(threads, "p", "fix/login", null)?.id, "a");
  assert.equal(linkedRepairThread(threads, "p", "fix/login", "new"), undefined);
  assert.equal(linkedRepairThread(threads, "p", "other", null), undefined);
  assert.ok(repairBlocked({ status: "awaiting-approval" }));
  assert.ok(!repairBlocked(undefined));
});

test("selected comments become the repair prompt", () => {
  const finding = { id: 7, author: "octo", body: "Handle the empty state", state: "COMMENTED", path: null, line: null, side: null, url: "", updated_at: "" };
  const draft = toggleReviewFinding(emptyReviewDraft(), "comments:7", finding);
  const prompt = repairReviewPrompt(42, "Fix login redirect", "https://github.com/o/r/pull/42", "abc123", draft);
  assert.match(prompt, /Repair pull request #42/);
  assert.match(prompt, /Review by octo\nHandle the empty state/);
});
