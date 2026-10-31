import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVE_REFRESH_MS,
  ERROR_CONTEXT,
  IDLE_REFRESH_MS,
  LOG_PAGE,
  LOG_WINDOW,
  elapsed,
  eventWord,
  failedStep,
  finishNotice,
  finishedSince,
  fixPrompt,
  joinPage,
  nextRead,
  openingOffset,
  parseLogLine,
  refreshDelay,
  runBucket,
  runWord,
  shouldAnnounce,
  snapshotRuns,
  stripAnsi,
} from "../src/actions.ts";

const run = (over = {}) => ({
  id: 1, number: 695, attempt: 1, workflow_name: "CI", workflow_id: 3, title: "Fix the importer", head_branch: "main",
  head_sha: "356376dfbd67d8dd6b0bb87027a09a9fced0dba2", event: "push", status: "completed", conclusion: "failure",
  url: "https://github.com/o/r/actions/runs/1", created_at: "2026-10-31T15:37:44Z", updated_at: "2026-10-31T15:39:06Z", actor: "ana",
  ...over,
});

test("runs, jobs and steps read as one bucket and word", () => {
  assert.equal(runBucket({ status: "in_progress" }), "running");
  assert.equal(runBucket({ status: "queued" }), "queued");
  assert.equal(runBucket({ status: "waiting" }), "queued");
  assert.equal(runBucket({ status: "completed", conclusion: "success" }), "passed");
  assert.equal(runBucket({ status: "completed", conclusion: "cancelled" }), "cancelled");
  assert.equal(runBucket({ status: "completed", conclusion: "skipped" }), "skipped");
  for (const c of ["failure", "timed_out", "startup_failure", "action_required"]) assert.equal(runBucket({ status: "completed", conclusion: c }), "failed", c);
  assert.equal(runWord({ status: "completed", conclusion: "timed_out" }), "Timed out");
  assert.equal(runWord({ status: "waiting" }), "Waiting");
  assert.equal(runWord({ status: "completed", conclusion: "success" }), "Passed");
  assert.equal(eventWord("workflow_dispatch"), "Manual");
  assert.equal(eventWord("pull_request"), "Pull request");
  assert.equal(eventWord("check_suite"), "Check suite");
});

test("elapsed time reads in the largest two units", () => {
  assert.equal(elapsed("2026-10-31T15:00:00Z", "2026-10-31T15:00:45Z"), "45s");
  assert.equal(elapsed("2026-10-31T15:00:00Z", "2026-10-31T15:01:12Z"), "1m 12s");
  assert.equal(elapsed("2026-10-31T15:00:00Z", "2026-10-31T17:03:00Z"), "2h 3m");
  assert.equal(elapsed("2026-10-31T15:00:00Z", undefined, Date.parse("2026-10-31T15:00:30Z")), "30s");
  assert.equal(elapsed(undefined, undefined), "");
});

test("refresh every 10 s for a visible running run, 60 s otherwise, never while hidden", () => {
  assert.equal(refreshDelay({ active: true, onScreen: true, windowVisible: true }), ACTIVE_REFRESH_MS);
  assert.equal(refreshDelay({ active: true, onScreen: false, windowVisible: true }), IDLE_REFRESH_MS);
  assert.equal(refreshDelay({ active: false, onScreen: true, windowVisible: true }), IDLE_REFRESH_MS);
  assert.equal(refreshDelay({ active: true, onScreen: true, windowVisible: false }), null);
  assert.equal(ACTIVE_REFRESH_MS, 10_000);
  assert.equal(IDLE_REFRESH_MS, 60_000);
});

test("a run finishes once: seen unfinished, completed now", () => {
  const before = snapshotRuns([run({ id: 1, status: "in_progress", conclusion: "" }), run({ id: 2 }), run({ id: 3, status: "queued", conclusion: "" })]);
  const now = [run({ id: 1 }), run({ id: 2 }), run({ id: 3, status: "in_progress", conclusion: "" }), run({ id: 4 })];
  assert.deepEqual(finishedSince(before, now).map(r => r.id), [1], "2 was already done, 3 still runs, 4 is history");
  assert.deepEqual(finishedSince(snapshotRuns(now), now), [], "no second notice");
  const rerun = [run({ id: 2, attempt: 2 })];
  assert.deepEqual(finishedSince(snapshotRuns([run({ id: 2 })]), rerun).map(r => r.id), [2], "a rerun that finished between reads");
});

test("notices go to runs the user started or runs on their branch", () => {
  const none = { started: new Set() };
  assert.equal(shouldAnnounce(run(), none), false);
  assert.equal(shouldAnnounce(run(), { started: new Set([1]) }), true);
  assert.equal(shouldAnnounce(run({ head_branch: "feat/x" }), { ...none, branch: "feat/x" }), true);
  assert.equal(shouldAnnounce(run({ head_branch: "main" }), { ...none, branch: "feat/x" }), false);
  assert.equal(shouldAnnounce(run({ event: "workflow_dispatch" }), { ...none, viewer: "ana" }), true);
  assert.equal(shouldAnnounce(run({ attempt: 2 }), { ...none, viewer: "ana" }), true);
  assert.equal(shouldAnnounce(run(), { ...none, viewer: "ana" }), false, "a push is not a run they started by hand");
  assert.deepEqual(finishNotice(run()), { title: "CI #695 failed", body: "main · Fix the importer", kind: "error" });
  assert.equal(finishNotice(run({ conclusion: "success" })).title, "CI #695 passed");
  assert.equal(finishNotice(run({ conclusion: "timed_out" })).title, "CI #695 timed out");
});

test("log lines map GitHub markers and ANSI colours, never showing escapes", () => {
  assert.deepEqual(parseLogLine("##[group]Run cargo test"), { text: "Run cargo test", tone: "group" });
  assert.equal(parseLogLine("##[endgroup]").hidden, true);
  assert.deepEqual(parseLogLine("##[error]Process completed with exit code 1."), { text: "Error: Process completed with exit code 1.", tone: "error" });
  assert.equal(parseLogLine("##[warning]old node").tone, "warning");
  assert.deepEqual(parseLogLine("[command]/usr/bin/git fetch"), { text: "/usr/bin/git fetch", tone: "command" });
  assert.deepEqual(parseLogLine("\u001b[1m\u001b[31merror[E0716]\u001b[0m: temporary value"), { text: "error[E0716]: temporary value", tone: "error" });
  assert.equal(parseLogLine("\u001b[32m✓\u001b[0m 12 passed").tone, "success");
  assert.equal(parseLogLine("\u001b[38;5;196mx\u001b[33m warn").tone, "warning", "256-colour codes are skipped, not misread");
  assert.equal(parseLogLine("\u001b[90mdim\u001b[0m").tone, "muted");
  assert.equal(stripAnsi("\u001b]8;;https://x\u0007link\u001b]8;;\u0007 \u001b[2K\u001b[1Gdone"), "link done");
  assert.equal(parseLogLine("plain\ttab").text, "plain    tab");
});

test("the log window pages both ways and stays bounded", () => {
  assert.equal(openingOffset(5000, [4100, 4200], true), 4200 - ERROR_CONTEXT);
  assert.equal(openingOffset(300, [5], true), 0, "near the top it opens at the top");
  assert.equal(openingOffset(5000, [4999], true), 4999 - ERROR_CONTEXT);
  assert.equal(openingOffset(5000, [100], false), 0);
  const lines = (from, n) => Array.from({ length: n }, (_, i) => `line ${from + i}`);
  let window = { offset: 1000, lines: lines(1000, 500), total: 5000, errors: [] };
  assert.deepEqual(nextRead(window, "earlier"), { offset: 500, limit: 500 });
  assert.deepEqual(nextRead(window, "later"), { offset: 1500, limit: 500 });
  for (let from = 1500; from < 4000; from += 500) {
    window = joinPage(window, { available: true, offset: from, lines: lines(from, 500), total_lines: 5000 }, "later");
    assert.ok(window.lines.length <= LOG_WINDOW);
  }
  assert.equal(window.offset, 2000);
  assert.equal(window.lines[0], "line 2000");
  assert.equal(window.lines.at(-1), "line 3999");
  window = joinPage(window, { available: true, offset: 1500, lines: lines(1500, 500), total_lines: 5000 }, "earlier");
  assert.equal(window.offset, 1500);
  assert.equal(window.lines.length, LOG_WINDOW);
  assert.equal(window.lines.at(-1), "line 3499", "the far end is trimmed");
  assert.equal(nextRead({ offset: 0, lines: lines(0, 10), total: 10, errors: [] }, "earlier"), null);
  assert.equal(nextRead({ offset: 0, lines: lines(0, 10), total: 10, errors: [] }, "later"), null);
  const jumped = joinPage(window, { available: true, offset: 4500, lines: lines(4500, 500), total_lines: 5000 }, "later");
  assert.equal(jumped.offset, 4500, "a page that doesn't touch the window replaces it");
});

test("the fix prompt names the job, its failed step, the run and a bounded excerpt", () => {
  const job = { id: 9, name: "test (macos)", status: "completed", conclusion: "failure", url: "u", steps: [
    { number: 1, name: "Set up job", status: "completed", conclusion: "success" },
    { number: 4, name: "cargo test", status: "completed", conclusion: "failure" },
  ] };
  assert.equal(failedStep(job).name, "cargo test");
  const prompt = fixPrompt(run({ attempt: 2 }), job, ["\u001b[31merror\u001b[0m: boom", "x".repeat(20_000)]);
  assert.match(prompt, /^Fix the failing CI job “test \(macos\)” in CI #695 \(attempt 2\)\./);
  assert.match(prompt, /Run: https:\/\/github\.com\/o\/r\/actions\/runs\/1/);
  assert.match(prompt, /Branch: main at 356376dfbd67/);
  assert.match(prompt, /Failed step: cargo test/);
  assert.ok(!prompt.includes("\u001b"));
  assert.ok(prompt.length < 13 * 1024);
  assert.match(fixPrompt(run(), { ...job, steps: [] }, []), /no log for this job yet/);
});
